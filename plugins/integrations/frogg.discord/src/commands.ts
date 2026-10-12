// The /frogg slash command, as raw application-command JSON. Registered per guild (instant,
// and scoped to the one server the plugin is bound to).

const SUB_COMMAND = 1;
const SUB_COMMAND_GROUP = 2;
const STRING = 3;
const ATTACHMENT = 11;

export const COMMAND_NAME = "frogg";

const agentOption = (description: string) => ({
  type: STRING,
  name: "agent",
  description,
  required: false,
  autocomplete: true,
});

export const FROGG_COMMAND = {
  name: COMMAND_NAME,
  description: "Drive Frogg agents on this host",
  contexts: [0],
  options: [
    { type: SUB_COMMAND, name: "status", description: "Host summary: running, waiting and errored agents" },
    { type: SUB_COMMAND, name: "agents", description: "List agents and their threads" },
    {
      type: SUB_COMMAND,
      name: "new",
      description: "Start an agent in a workspace",
      options: [
        { type: STRING, name: "workspace", description: "Workspace to run in", required: true, autocomplete: true },
        { type: STRING, name: "prompt", description: "What the agent should do", required: true, max_length: 4000 },
        { type: STRING, name: "provider", description: "Agent provider", required: false, autocomplete: true },
        { type: STRING, name: "model", description: "Model id (provider default if empty)", required: false, max_length: 120 },
        { type: STRING, name: "title", description: "Title for the agent", required: false, max_length: 100 },
      ],
    },
    {
      type: SUB_COMMAND,
      name: "stop",
      description: "Cancel an agent's current turn",
      options: [agentOption("Agent to stop (defaults to this thread's agent)")],
    },
    {
      type: SUB_COMMAND,
      name: "reply",
      description: "Send a message to an agent",
      options: [
        { type: STRING, name: "text", description: "Message for the agent", required: true, max_length: 4000 },
        agentOption("Agent to message (defaults to this thread's agent)"),
        { type: ATTACHMENT, name: "attachment", description: "Image or file for the agent", required: false },
      ],
    },
    {
      type: SUB_COMMAND_GROUP,
      name: "todo",
      description: "Project to-dos",
      options: [
        {
          type: SUB_COMMAND,
          name: "add",
          description: "Add a project to-do",
          options: [
            { type: STRING, name: "title", description: "To-do title", required: true, max_length: 200 },
            { type: STRING, name: "description", description: "Details", required: false, max_length: 4000 },
            {
              type: STRING,
              name: "project",
              description: "Project (defaults to this thread's agent's project)",
              required: false,
              autocomplete: true,
            },
            {
              type: STRING,
              name: "priority",
              description: "Priority",
              required: false,
              choices: ["low", "medium", "high", "urgent"].map((p) => ({ name: p, value: p })),
            },
          ],
        },
      ],
    },
  ],
} as const;
