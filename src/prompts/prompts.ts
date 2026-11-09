import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Prompts encode the working protocol so any MCP-compatible agent behaves
 * the same way inside this workspace. All prompts assume the bootstrap tools
 * (workspace_open, brain_read, task_list) are available.
 */

const PROTOCOL = `Rules you MUST follow in this workspace:
1. The MCP workspace is the only source of truth for project files, memory, plans and outputs.
2. Never create a separate local copy of this project.
3. Read memory and the plan BEFORE editing anything.
4. Create or update tasks while you work; mark them done when finished.
5. Use file tools for project files; use terminal tools for execution — not your native shell/filesystem.
6. Pass expected_hash on writes; on HASH_CONFLICT re-read and retry.
7. Record durable decisions with decision_record; hand over with the session_handover prompt.
8. Wait for user approval after presenting a plan, before implementing.`;

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "coding_session_start",
    {
      description: "Bootstrap a coding session: open the workspace and report its state, then propose the next step and wait for approval.",
      argsSchema: {
        workspace: z.string().describe("Workspace slug, e.g. 'xcomb'"),
      },
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are working in the UNIVERSAL remote workspace. Workspace: ${args.workspace}.

${PROTOCOL}

Do this now:
1. workspace_open("${args.workspace}")
2. brain_read (full) and task_list (status != done) to see where the project stands
3. Report: current state, in-progress work, blockers, and the ONE next step you recommend
4. Wait for explicit approval before editing files or running commands.`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "project_analysis",
    {
      description: "Deep-analyze the project in the workspace and record findings in memory.",
      argsSchema: {
        workspace: z.string().describe("Workspace slug"),
        focus: z.string().optional().describe("Optional area to focus on, e.g. 'architecture' or 'tests'"),
      },
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are in the UNIVERSAL remote workspace '${args.workspace}'.

${PROTOCOL}

Analyze the project${args.focus ? `, focusing on: ${args.focus}` : ""}:
1. workspace_open, then file_list (recursive) to map the tree
2. Read key files: README/PROJECT.md, entry points, configs, tests
3. Identify: purpose, stack, structure, strengths, weaknesses, risky areas${args.focus ? `, especially around ${args.focus}` : ""}
4. Write a structured summary with memory_add(kind='fact', title='Project Analysis — <date>')
5. Report your findings concisely to the user. Do not modify code.`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "implementation_plan",
    {
      description: "Turn an objective into a persisted plan + tasks. Approval-gated: the user must approve before implementation starts.",
      argsSchema: {
        workspace: z.string().describe("Workspace slug"),
        objective: z.string().describe("What the user wants to achieve"),
      },
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are in the UNIVERSAL remote workspace '${args.workspace}'.

${PROTOCOL}

Objective: ${args.objective}

Produce an implementation plan:
1. workspace_open; read brain_read + existing plan/tasks (plan_read, task_list)
2. Explore the codebase enough to ground the plan (file_list, file_read, file_search)
3. plan_create with a clear title and summary (context, approach, risks, testing strategy)
4. Break the plan into concrete tasks with task_create (subtasks via parent_task_id; priorities 1-5)
5. Present the plan to the user and STOP. Wait for explicit approval before implementing.`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "code_review",
    {
      description: "Review the current project state (or a diff you are given) and record decisions.",
      argsSchema: {
        workspace: z.string().describe("Workspace slug"),
        scope: z.string().optional().describe("Optional: files/paths to review or 'git diff'"),
      },
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are in the UNIVERSAL remote workspace '${args.workspace}'.

${PROTOCOL}

Review ${args.scope ? `this scope: ${args.scope}` : "the current state of the project"}:
1. workspace_open; get the state (git status/diff via terminal_execute, file_read, task_list)
2. Look for: bugs, security issues (secrets, injection, unsafe paths), design drift vs Brain.md decisions, missing tests
3. Record significant findings with decision_record (what + why) when they require durable choices
4. Do NOT fix anything yet — present findings and recommendations, wait for direction.`,
          },
        },
      ],
    })
  );

  server.registerPrompt(
    "session_handover",
    {
      description: "Write a handover note for the next agent/session, updating memory and the plan.",
      argsSchema: {
        workspace: z.string().describe("Workspace slug"),
      },
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `You are in the UNIVERSAL remote workspace '${args.workspace}'.

${PROTOCOL}

Prepare a clean handover:
1. workspace_open; review what you did this session (session_history, task_list)
2. Complete or update tasks to reflect reality; move anything unfinished to a clear state
3. Update Brain.md: brain_update(section='Current State', ...) with what works / what's broken / next steps
4. memory_add(kind='handover', title='Handover — <date>', content=summary of state, decisions, blockers, recommended next actions)
5. Print the handover note for the user to read.`,
          },
        },
      ],
    })
  );
}
