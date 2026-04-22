# KB Project Context

Load the full context of a specific project — its status, decisions, questions, milestones, people, source files, and everything related. After loading, read the source files to deeply understand where the project stands.

## Instructions

1. First, list available projects:
```bash
orka kb list --type project
```

2. Load the project's context (replace `<project-id>` with the actual ID):
```bash
orka kb context --project <project-id>
```

This outputs:
- **Project header** — status, description, owner, target release, repo path
- **Decisions** — what's been decided for this project
- **Questions** — what's still open
- **Milestones** — deadlines and targets
- **Directions** — strategic context
- **People** — who's involved
- **Repositories** — codebases related to this project
- **Source Files** — list of files that contain detailed context

3. **Read the source files** listed in the "Source Files" section. These are the actual meeting notes, specs, PRDs, and documents that contain the detailed context:

```bash
# Read each source file listed
cat path/to/meeting-notes.md
cat path/to/prd.md
cat path/to/spec.md
```

Read as many source files as needed to fully understand the project. Priority:
- Meeting notes (`notes_path`) — conversations and decisions
- Project folder (`path`) — specs, designs, documents
- Profile paths (`profile_path`) — who's who

4. After reading, summarize your understanding back to the user:
- What is this project about?
- What's the current status and next steps?
- What decisions have been made?
- What questions are still open?
- What's blocked or needs attention?

## Usage examples

```
/kb-project-context
> Load context for the Top 5 Contacts Card project

/kb-project-context
> What's the status of the AI Routing project?

/kb-project-context
> Catch me up on everything related to prj-xxx
```

## Tips

- If no project is specified, ask the user which one they want
- After loading context, you have deep understanding — use it to answer questions, suggest next steps, or help with implementation
- If the project has a `repo_path`, you can also explore the codebase
- Use `/kb-track` after discussing to capture any new decisions or questions that come up
