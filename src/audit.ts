import { Annotation, StateGraph } from "@langchain/langgraph";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import "dotenv/config";

const llm = new ChatGoogleGenerativeAI({ model: "gemini-2.5-flash" });

const reviewerLlm = llm.withStructuredOutput(
    {
        type: "object",
        description: "Rapport d'audit CI : sécurité, qualité et présence de tests unitaires pertinents.",
        properties: {
            isSecureAndTested: {
                type: "boolean",
                description:
                    "true uniquement si le code est acceptable pour merge : pas de failles évidentes et tests unitaires pertinents couvrant le comportement.",
            },
            reviewReport: {
                type: "string",
                description:
                    "Synthèse des constats : manque de tests, risques, suggestions. Reste factuel et concis.",
            },
        },
        required: ["isSecureAndTested", "reviewReport"],
    },
    { name: "ci_code_review" },
);

export const AuditState = Annotation.Root({
    prDiff: Annotation<string>({
        reducer: (x, y) => y,
        default: () => "",
    }),
    reviewReport: Annotation<string>({
        reducer: (x, y) => y,
        default: () => "",
    }),
    isSecureAndTested: Annotation<boolean>({
        reducer: (x, y) => y,
        default: () => false,
    }),
    fixedCode: Annotation<string>({
        reducer: (x, y) => y,
        default: () => "",
    }),
    iterations: Annotation<number>({
        reducer: (current, next) => current + next,
        default: () => 0,
    }),
});

async function reviewNode(state: typeof AuditState.State) {
    const codeUnderReview =
        state.fixedCode.trim().length > 0 ? state.fixedCode : state.prDiff;

    const messages = [
        new SystemMessage(
            `Tu es un auditeur de code CI/CD intraitable. Tu analyses le diff ou le fichier proposé.
Tu vérifies notamment :
- présence et pertinence de tests unitaires (couverture logique du comportement, pas uniquement des stubs vides) ;
- absence de patterns dangereux évidents dans l’extrait fourni.
Tu réponds uniquement via le schéma structuré demandé.`,
        ),
        new HumanMessage(
            `Code à auditer :\n\n\`\`\`\n${codeUnderReview}\n\`\`\`\n`,
        ),
    ];

    const result = await reviewerLlm.invoke(messages);

    return {
        isSecureAndTested: Boolean(result.isSecureAndTested),
        reviewReport: String(result.reviewReport ?? ""),
        iterations: 1,
    };
}

async function fixNode(state: typeof AuditState.State) {
    const currentCode =
        state.fixedCode.trim().length > 0 ? state.fixedCode : state.prDiff;

    const messages = [
        new SystemMessage(
            `Tu es un développeur correcteur en pipeline CI. Tu complètes le code avec les tests unitaires manquants ou insuffisants.
Règles strictes :
- Réponds avec le code source brut uniquement (aucun markdown, aucune ligne \`\`\`, aucun commentaire hors code).
- Le résultat doit être un fichier cohérent : conserve la logique existante et ajoute les tests demandés dans le rapport.`,
        ),
        new HumanMessage(
            `Rapport de l'auditeur :\n${state.reviewReport}\n\nCode actuel :\n${currentCode}\n`,
        ),
    ];

    const response = await llm.invoke(messages);
    const content = response.content;
    const raw =
        typeof content === "string"
            ? content
            : Array.isArray(content)
                ? content
                    .map((b) =>
                        typeof b === "object" && b !== null && "text" in b
                            ? String((b as { text: string }).text)
                            : "",
                    )
                    .join("")
                : String(content ?? "");

    const fixedCode = raw
        .replace(/^```(?:rust)?\s*\n?/i, "")
        .replace(/\n?```\s*$/i, "")
        .trim();

    return { fixedCode };
}

const workflow = new StateGraph(AuditState)
    .addNode("review", reviewNode)
    .addNode("fix", fixNode);

workflow.addEdge("__start__", "review");

workflow.addConditionalEdges(
    "review",
    (state) => {
        if (state.isSecureAndTested || state.iterations >= 3) return "end";
        return "fix";
    },
    {
        end: "__end__",
        fix: "fix",
    },
);

workflow.addEdge("fix", "review");

export const auditApp = ;

const FALLBACK_PR_DIFF = `fn add(a: i32, b: i32) -> i32 { a + b }`;

async function run() {
    const fromEnv = (process.env.PR_DIFF ?? "").trim();
    const useEnv = fromEnv.length > 0;

    console.log(
        useEnv
            ? "▶ Mode : CI/CD (Variable d'environnement)"
            : "▶ Mode : Local (Fallback)",
    );

    const prDiff = useEnv ? fromEnv : FALLBACK_PR_DIFF;

    console.log("🔍 Audit CI — lancement du graphe\n");

    const finalState = await auditApp.invoke({
        prDiff,
    });

    console.log("--- État final ---");
    console.log("Iterations:", finalState.iterations);
    console.log("isSecureAndTested:", finalState.isSecureAndTested);
    console.log("\n--- reviewReport ---\n");
    console.log(finalState.reviewReport);
    console.log("\n--- fixedCode (si corrigé) ---\n");
    console.log(finalState.fixedCode || "(inchangé — audit passé dès la première revue)");
}

run().catch(console.error);
