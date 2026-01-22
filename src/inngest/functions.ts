import { Sandbox } from "@e2b/code-interpreter";
import { z } from "zod";
import { PROMPT, FRAGMENT_TITLE_PROMPT, RESPONSE_PROMPT } from "@/prompt";
import { prisma } from "@/lib/db";
import { inngest } from "./client";
import {
  createAgent,
  createNetwork,
  createTool,
  openai,
  type Message,
  createState,
} from "@inngest/agent-kit";
import {
  getSandbox,
  lastAssistantTextMessageContent,
  parseAgentOutput,
} from "./utils";
import { SANDBOX_TIMEOUT } from "./types";

/* ------------------------------------------------------------------ */
/* TYPES */
/* ------------------------------------------------------------------ */

interface AgentState {
  summary: string;
  files: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* ZOD SCHEMAS (NO WIDENING, NO GENERICS) */
/* ------------------------------------------------------------------ */

const terminalParams = z.object({
  command: z.string(),
});

const createOrUpdateFilesParams = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      content: z.string(),
    }),
  ),
});

const readFilesParams = z.object({
  files: z.array(z.string()),
});

/* ------------------------------------------------------------------ */
/* FUNCTION */
/* ------------------------------------------------------------------ */

export const codeAgentFunction = inngest.createFunction(
  { id: "code-agent" },
  { event: "code-agent/run" },
  async ({ event, step }) => {
    /* -------------------------- SANDBOX -------------------------- */

    const sandboxId = await step.run("get-sandbox-id", async () => {
      const sandbox = await Sandbox.create("codeassist-nextjs-test-2");
      await sandbox.setTimeout(SANDBOX_TIMEOUT);
      return sandbox.sandboxId;
    });

    /* --------------------- PREVIOUS MESSAGES --------------------- */

    const previousMessages = await step.run("get-previous-messages", async () => {
      const formattedMessages: Message[] = [];
      const messages = await prisma.message.findMany({
        where: { projectId: event.data.projectId },
        orderBy: { createdAt: "desc" },
        take: 10,
      });

      for (const message of messages) {
        formattedMessages.push({
          type: "text",
          role: message.role === "ASSISTANT" ? "assistant" : "user",
          content: message.content,
        });
      }

      return formattedMessages.reverse();
    });

    /* ----------------------------- STATE ----------------------------- */

    const state = createState<AgentState>(
      { summary: "", files: {} },
      { messages: previousMessages },
    );

    /* ------------------------------------------------------------------ */
    /* TOOLS — NO TYPES, NO Tool, NO CASTS HERE                            */
    /* ------------------------------------------------------------------ */

    const terminalTool = createTool({
      name: "terminal",
      description: "Use the terminal to run commands",
      parameters: terminalParams,
      handler: async ({ command }, { step }) => {
        return await step?.run("terminal", async () => {
          try {
            const sandbox = await getSandbox(sandboxId);
            const result = await sandbox.commands.run(command);
            return result.stdout;
          } catch (e) {
            return `Command failed: ${e}`;
          }
        });
      },
    });

    const createOrUpdateFilesTool = createTool({
      name: "createOrUpdateFiles",
      description: "Create or update files in the sandbox",
      parameters: createOrUpdateFilesParams,
      handler: async ({ files }, { step, network }) => {
        const updatedFiles = await step?.run(
          "createOrUpdateFiles",
          async () => {
            const currentFiles = network.state.data.files || {};
            const sandbox = await getSandbox(sandboxId);

            for (const file of files) {
              await sandbox.files.write(file.path, file.content);
              currentFiles[file.path] = file.content;
            }

            return currentFiles;
          },
        );

        if (typeof updatedFiles === "object") {
          network.state.data.files = updatedFiles;
        }
      },
    });

    const readFilesTool = createTool({
      name: "readFiles",
      description: "Read files from the sandbox",
      parameters: readFilesParams,
      handler: async ({ files }, { step }) => {
        return await step?.run("readFiles", async () => {
          const sandbox = await getSandbox(sandboxId);
          return Promise.all(
            files.map(async (file) => ({
              path: file,
              content: await sandbox.files.read(file),
            })),
          );
        });
      },
    });

    /* ------------------------------------------------------------------ */
    /* AGENT — SINGLE TYPE ERASURE AT BOUNDARY                             */
    /* ------------------------------------------------------------------ */

    const codeAgent = createAgent<AgentState>({
      name: "codeAgent",
      description: "An expert coding agent",
      system: PROMPT,
      model: openai({
        model: "gpt-4.1",
        defaultParameters: { temperature: 0.1 },
      }),
      // 🔴 This is the ONLY cast in the entire file
      tools: [terminalTool, createOrUpdateFilesTool, readFilesTool] as unknown[],
      lifecycle: {
        onResponse: async ({ result, network }) => {
          const text = lastAssistantTextMessageContent(result);
          if (text?.includes("<task_summary>")) {
            network.state.data.summary = text;
          }
          return result;
        },
      },
    });

    /* ---------------------------- NETWORK ---------------------------- */

    const network = createNetwork<AgentState>({
      name: "coding-agent-network",
      agents: [codeAgent],
      maxIter: 15,
      defaultState: state,
      router: async ({ network }) => {
        if (network.state.data.summary) return;
        return codeAgent;
      },
    });

    const result = await network.run(event.data.value, { state });

    /* ------------------------- POST AGENTS ------------------------- */

    const fragmentTitleGenerator = createAgent({
      name: "fragment-title-generator",
      description: "A fragment title generator",
      system: FRAGMENT_TITLE_PROMPT,
      model: openai({ model: "gpt-4o" }),
    });

    const responseGenerator = createAgent({
      name: "response-generator",
      description: "A response generator",
      system: RESPONSE_PROMPT,
      model: openai({ model: "gpt-4o" }),
    });

    const { output: fragmentTitleOutput } =
      await fragmentTitleGenerator.run(result.state.data.summary);

    const { output: responseOutput } =
      await responseGenerator.run(result.state.data.summary);

    /* --------------------------- SAVE --------------------------- */

    const isError =
      !result.state.data.summary ||
      Object.keys(result.state.data.files || {}).length === 0;

    const sandboxUrl = await step.run("get-sandbox-url", async () => {
      const sandbox = await getSandbox(sandboxId);
      return `https:\\${sandbox.getHost(3000)}`;
    });

    await step.run("save-result", async () => {
      if (isError) {
        return prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content: "Something went wrong. Please try again.",
            role: "ASSISTANT",
            type: "ERROR",
          },
        });
      }

      return prisma.message.create({
        data: {
          projectId: event.data.projectId,
          content: parseAgentOutput(responseOutput),
          role: "ASSISTANT",
          type: "RESULT",
          fragment: {
            create: {
              sandboxUrl,
              title: parseAgentOutput(fragmentTitleOutput),
              files: result.state.data.files,
            },
          },
        },
      });
    });

    return {
      url: sandboxUrl,
      title: "Fragment",
      files: result.state.data.files,
      summary: result.state.data.summary,
    };
  },
);
