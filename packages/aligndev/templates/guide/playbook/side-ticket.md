# Runbook: Side ticket

For new single-project work where the user explicitly says there is no ticket or asks for a side ticket. Complete `{{GUIDE}} work-files-setup` from PROJECT_PATH, then:

{{#openclaw}}
1. Run `{{ALIGNFIRST}} assistant-instructions` from the selected workplace, or deliberately from PROJECT_PATH when no workplace is selected. It prints the project conventions and the project's assistant instructions.
2. Run `{{ALIGNFIRST}} sync`, so identifier selection sees the current shared task set.
3. Run `{{ALIGNFIRST}} ticket --side` from PROJECT_PATH (`exec`). It creates the ticket directory and prints it as TICKET_DIR; TICKET_ID is the `side-N` it reports.
{{#thread}}
4. Write `{TICKET_DIR}A1-request.md` with the complete original request from the starter's Request block, short requests included. Preserve every requirement and the explicit no-ticket choice, together with any later human corrections.
{{/thread}}
{{#app}}
4. Write `{TICKET_DIR}A1-request.md` with the complete request. For a short request, use the user's request and the message that explicitly confirmed no ticket.
{{/app}}
5. Run `{{ALIGNFIRST}} sync`.
{{/openclaw}}
{{#codingAgent}}
1. Run `{{ALIGNFIRST}} sync`, so identifier selection sees the current shared task set.
2. Run `{{ALIGNFIRST}} ticket --side` from PROJECT_PATH. It creates the ticket directory and prints it as TICKET_DIR; TICKET_ID is the `side-N` it reports.
3. Write `{TICKET_DIR}A1-request.md` with the complete request. For a short request, use the user's request and the message that explicitly confirmed no ticket.
4. Run `{{ALIGNFIRST}} sync`.
{{/codingAgent}}

{{#thread}}
You own this reservation and the request capture; the agent receives TICKET_ID. Do not use `{{ALIGNDEV}} code new --no-ticket`: TICKET_ID must exist before delegation, for the request file and the workspace. Continue to workspace setup with the side ticket as TICKET_ID, then run the coding protocol from the returned linked worktree.
{{/thread}}
{{#conversation}}
You own this reservation and the request capture; the agent receives TICKET_ID. Do not use `{{ALIGNDEV}} code new --no-ticket`: TICKET_ID must exist before delegation, for the request file and the workspace. Continue with `{{GUIDE}} project-workspace-setup`, which decides the workplace with the side ticket as TICKET_ID, then run the coding protocol from that workplace.
{{/conversation}}
