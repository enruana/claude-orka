---
name: kb-ingest
description: Extract structured knowledge (decisions, tasks, questions, people, milestones) from a document — meeting notes, spec, transcript, RFC — into the KB with source provenance. Use when the user pastes or attaches long-form content to capture.
---

# KB Ingest (v2)

Process a document (meeting notes, spec, conversation transcript, RFC) and extract structured knowledge into the KB. **Always pass `--skill kb-ingest`** so extracted entities get auto-provenance back to this skill.

For the full v2 model, see `/kb-guide`.

## Instructions

1. Read the file or content the user provides.

2. **Load existing context** to avoid duplicates:
```bash
orka kb context
```

3. **Create the source entity FIRST** — every entity you extract will link back to it via `sourced-from`:

```bash
# For a meeting transcript:
orka kb add meeting "Sprint Planning 2026-05-05" \
  --skill kb-ingest \
  --strict \
  --property date=2026-05-05 \
  --property "attendees=felipe, ana, colin" \
  --property notes_path="01-journal/2026/05-may/2026-05-05_sprint-planning/notes.md"

# For a PRD/spec:
orka kb add artifact "PRD #2 - Chat & RAG Integration" \
  --skill kb-ingest \
  --strict \
  --status active \
  --property description="Spec for adding RAG to chat product" \
  --property path="03-projects/active/prd-2-chat-rag/PRD.md" \
  --property kind=prd \
  --tag prd
```

4. Extract and create entities for each pattern in the doc. Always include `description` and link to the source via `sourced-from`:

   **Decisions** ("we decided...", "going with..."):
   ```bash
   orka kb add decision "Use Pinecone for vector store" \
     --skill kb-ingest --strict \
     --status accepted \
     --property description="Vector DB choice for the RAG pipeline" \
     --property "drivers=managed, k8s-friendly, latency budget" \
     --property "options=Pinecone|Weaviate|pgvector" \
     --property outcome="Pinecone — least ops overhead, fits our latency target" \
     --property "consequences=Vendor lock-in; need export plan for portability" \
     --property decided_by="aerika" \
     --link decided-at:<meeting-id> \
     --link sourced-from:<meeting-id>
   ```

   **Questions** (TBD, "?", "we need to figure out..."):
   ```bash
   orka kb add question "What's the cost ceiling for Pinecone at 10x scale?" \
     --skill kb-ingest --strict \
     --link raised-at:<meeting-id> \
     --link addresses:<direction-id>     # if related to a strategic direction
   ```

   **Work items** committed to in the doc — pick the right tier:
   ```bash
   # A task within an existing project
   orka kb add task "Add embedding pipeline to chat-rag service" \
     --skill kb-ingest --strict \
     --property description="Wire OpenAI embeddings + Pinecone upsert" \
     --property owner="felipe" \
     --link scope-of:<project-id> \
     --link sourced-from:<meeting-id>

   # A spike
   orka kb add spike "Compare embedding models for retrieval quality" \
     --skill kb-ingest --strict \
     --property description="Test ada-002 vs cohere-embed-v3 on internal eval set" \
     --property time_box="3 days" \
     --link scope-of:<project-id>

   # A bug
   orka kb add bug "RAG returns empty results for German queries" \
     --skill kb-ingest --strict \
     --property description="Multilingual support broken in current setup" \
     --property severity="medium" \
     --link child-of:<project-id>
   ```

   **People** with their roles:
   ```bash
   orka kb add person "Ana Garcia" \
     --skill kb-ingest --strict \
     --property role="Backend Lead" \
     --property profile_path="02-people/ana-garcia/" \
     --link sourced-from:<meeting-id>
   ```

   **Milestones** (deadlines/targets mentioned):
   ```bash
   orka kb add milestone "Beta launch — chat with RAG enabled" \
     --skill kb-ingest --strict \
     --property target="2026-06-30" \
     --property criteria="100 internal users, p95 latency < 1s" \
     --link sourced-from:<meeting-id>
   ```

5. **Always add `sourced-from` to the source you created in step 3.** This is the chain that lets `/kb-project-context` find related docs later.

6. **Regenerate the project INDEX.md** for any project that was touched:
```bash
orka kb project-doc <project-id>
```

7. **Run lint** at the end to verify everything is clean:
```bash
orka kb lint
```

8. Show the user a summary: which source was ingested, which entities were created, and which projects had their INDEX.md regenerated.

## Validation rules

- `meeting` requires `date` property
- `decision` requires `description` and `outcome`
- All work-tier entities require `description`
- Provenance: every entity created with `--skill kb-ingest` gets a `generated-by` edge automatically; you still need to add the `sourced-from` link manually because that's about *content* provenance (the source doc), not skill provenance.

## Path convention

**All paths from project root**, never relative:
- ✅ `01-journal/2026/05-may/sprint-planning/notes.md`
- ❌ `../sprint-planning/notes.md`

## Tips

- If the doc has a clear date or version, use it as the source's title (e.g. "Sprint Planning 2026-05-05").
- When the doc references a person you don't have in the KB yet, create them with `--skill kb-ingest`. They'll show up linked to the meeting + this ingest activity.
- For long docs, do multiple ingest passes — first decisions, then questions, then work items. Easier to review.
- If you're unsure about a relation type, run `orka kb relations` to see the constraints.
