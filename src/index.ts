import { Annotation, StateGraph } from "@langchain/langgraph";
import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { mkdir, readFile, writeFile } from "fs/promises";
import { basename, join } from "node:path";
import "dotenv/config";

const llm = new ChatGoogleGenerativeAI({ model: "gemini-2.5-flash" });

const writeCodeToFileSchema = z.object({
    filename: z.string().describe("Nom du fichier (ex: login.ts)"),
    code: z.string().describe("Contenu source complet à enregistrer"),
});

const writeCodeToFileTool = tool(
    async ({ filename, code }) => {
        const safeName = basename(filename);
        const dir = join(process.cwd(), "generated");
        await mkdir(dir, { recursive: true });
        const filePath = join(dir, safeName);
        await writeFile(filePath, code, "utf8");
        return `Fichier écrit : ${filePath}`;
    },
    {
        name: "write_code_to_file",
        description:
            "Écrit le code source dans un fichier sur le disque. Obligatoire pour livrer le travail du dev.",
        schema: writeCodeToFileSchema,
    },
);

/** Schéma JSON pour le nœud QA : l’API renvoie du JSON valide (plus de texte libre avec backslashes invalides). */
const qaLlm = llm.withStructuredOutput(
    {
        type: "object",
        description: "Résultat de la revue QA sur le code.",
        properties: {
            isApproved: {
                type: "boolean",
                description: "true si le code est conforme au plan et acceptable pour une PR.",
            },
            feedback: {
                type: "string",
                description:
                    "Si refus : détaillez le problème (sans blocs de code longs). Si accepté : courte phrase de validation.",
            },
        },
        required: ["isApproved", "feedback"],
    },
    { name: "qa_review" },
);

// 1. Définition de l'État (le "tableau blanc" de l'équipe)
export const TeamState = Annotation.Root({

    // Brief BMAD (chargé depuis .ugokin/brief.md)
    brief: Annotation<string>({
        reducer: (x, y) => y,
        default: () => "",
    }),

    // Règles BMAD (chargé depuis .ugokin/rules.md)
    rules: Annotation<string>({
        reducer: (x, y) => y,
        default: () => "",
    }),

    // Le plan technique écrit par l'Architecte (étape « Map »)
    plan: Annotation<string>({
        reducer: (x, y) => y,
        default: () => "",
    }),

    // Le code écrit par le Dev
    code: Annotation<string>({
        reducer: (x, y) => y,
        default: () => "",
    }),

    // Le rapport de bug écrit par le QA
    feedback: Annotation<string>({
        reducer: (x, y) => y,
        default: () => "",
    }),

    // Un compteur pour éviter que le Dev et le QA tournent en boucle à l'infini
    iterations: Annotation<number>({
        reducer: (current, next) => current + next, // Ici, contrairement aux autres, on additionne (+1 à chaque passage)
        default: () => 0,
    }),

    // Le QA valide-t-il le code ? (utilisé pour la condition de sortie de boucle)
    isApproved: Annotation<boolean>({
        reducer: (x, y) => y,
        default: () => false,
    }),
});

// 2. Définition des Nœuds (Nos Agents)

const BRIEF_PATH = join(process.cwd(), ".ugokin", "brief.md");
const RULES_PATH = join(process.cwd(), ".ugokin", "rules.md");

async function readUgokinFile(path: string, kind: "brief" | "rules"): Promise<string> {
    try {
        return await readFile(path, "utf8");
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") {
            console.warn(`⚠️ Fichier ${kind} introuvable : ${path}`);
            return kind === "brief"
                ? "(Aucun brief : le fichier .ugokin/brief.md est absent.)"
                : "(Aucune règle : le fichier .ugokin/rules.md est absent.)";
        }
        throw err;
    }
}

async function briefNode(_state: typeof TeamState.State) {
    console.log("📋 briefNode : chargement du brief et des règles BMAD…");
    const [brief, rules] = await Promise.all([
        readUgokinFile(BRIEF_PATH, "brief"),
        readUgokinFile(RULES_PATH, "rules"),
    ]);
    return { brief, rules };
}

async function architectNode(state: typeof TeamState.State) {
    console.log("👷‍♂️ Architecte / Map (Gemini) : Réflexion en cours…");

    const messages = [
        new SystemMessage(
            "Tu es un Architecte Logiciel (étape Map BMAD). À partir du brief et des règles, produis un plan d'action détaillé. Ne rédige jamais de code source.",
        ),
        new HumanMessage(
            `## Brief\n\n${state.brief}\n\n## Règles\n\n${state.rules}`,
        ),
    ];

    try {
        // On tente d'appeler l'API
        const response = await llm.invoke(messages);
        console.log("✅ Réponse de l'API reçue !");
        return { plan: response.content as string };

    } catch (error) {
        // Si ça plante, on affiche l'erreur exacte en rouge dans la console
        console.error("❌ Erreur de l'API Gemini :", error);

        // On retourne un faux plan pour ne pas bloquer tout le graphe
        return { plan: "Erreur technique de l'Architecte." };
    }
}

async function devNode(state: typeof TeamState.State) {
    console.log("👨‍💻 Dev (Gemini) : Écriture du code...");

    const devLlm = llm.bindTools([writeCodeToFileTool]);

    const messages = [
        new SystemMessage(
            `Tu es un Développeur expert. Tu DOIS appeler l'outil write_code_to_file avec :
- filename : un nom de fichier pertinent (ex: login.ts)
- code : le code source complet, propre et sécurisé
Ne te contente pas de répondre en texte sans appeler l'outil.`,
        ),
        new HumanMessage(`
        ## Brief
        ${state.brief}

        ## Règles
        ${state.rules}

        Plan à suivre : ${state.plan}
        Code actuel (s'il existe) : ${state.code}
        ${state.feedback ? `\n🚨 CORRECTION REQUISE suite au retour du QA : ${state.feedback}` : ""}
      `),
    ];

    const response = await devLlm.invoke(messages);

    if (AIMessage.isInstance(response) && response.tool_calls?.length) {
        for (const tc of response.tool_calls) {
            if (tc.name !== "write_code_to_file") continue;

            const rawArgs = tc.args;
            const args =
                typeof rawArgs === "string"
                    ? (JSON.parse(rawArgs) as z.infer<typeof writeCodeToFileSchema>)
                    : rawArgs;

            const filename = String(args.filename ?? "");
            const code = String(args.code ?? "");

            await writeCodeToFileTool.invoke({ filename, code });

            return { code };
        }
    }

    const fallback =
        typeof response.content === "string"
            ? response.content
            : Array.isArray(response.content)
                ? response.content
                    .map((b) => (typeof b === "object" && b !== null && "text" in b ? String((b as { text: string }).text) : ""))
                    .join("")
                : "";

    return { code: fallback };
}

async function qaNode(state: typeof TeamState.State) {
    console.log("🕵️‍♂️ QA (Gemini) : Inspection du code...");

    const messages = [
        new SystemMessage(`Tu es un Ingénieur QA intraitable. Tu vérifies que le code respecte le plan et ne contient pas d'erreurs.
Réponds via le schéma structuré demandé (isApproved, feedback). Dans feedback, reste concis ; évite d'insérer de gros extraits de code.`),
        new HumanMessage(`
        Plan de l'Architecte : ${state.plan}
        Code du Dev à tester : ${state.code}
      `)
    ];

    const qaResult = await qaLlm.invoke(messages);

    return {
        isApproved: Boolean(qaResult.isApproved),
        feedback: String(qaResult.feedback ?? ""),
    };
}

// 3. Assemblage du Graphe
const workflow = new StateGraph(TeamState)
    .addNode("brief", briefNode)
    .addNode("architect", architectNode)
    .addNode("dev", devNode)
    .addNode("qa", qaNode);

workflow.addEdge("__start__", "brief");
workflow.addEdge("brief", "architect");
workflow.addEdge("architect", "dev");
workflow.addEdge("dev", "qa");

// On définit le chemin conditionnel (La boucle de correction)
workflow.addConditionalEdges(
    "qa",
    (state) => {
        // Cette fonction lit l'État et retourne une chaîne de caractères
        if (state.isApproved) return "fin";
        if (state.iterations >= 3) return "fin"; // Notre sécurité anti-boucle infinie !
        return "retour_au_dev";
    },
    {
        // Ce dictionnaire fait correspondre la chaîne retournée au noeud de destination
        "fin": "__end__", // __end__ est un mot-clé natif
        "retour_au_dev": "dev"
    }
);

export const app = workflow.compile();

// 5. Lancement de notre équipe
async function run() {
    console.log("🚀 Lancement de la Team Dev...\n");

    const finalState = await app.invoke({});

    console.log("\n🏁 Processus terminé ! Voici le résultat final :");
    console.log("Code généré :", finalState.code);
    console.log("Dernier feedback :", finalState.feedback);
    console.log("Nombre d'itérations QA :", finalState.iterations);
}

run().catch(console.error);