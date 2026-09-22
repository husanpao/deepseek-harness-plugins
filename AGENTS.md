# AGENTS.md

## Word documents the user references

The `/word2md` command handles this without the model: the command plane runs it,
creates no message, and writes into the workspace `docs` folder. Its input is a
path — normally the `@file` mention the composer inserts, as in
`/word2md @docs/spec.docx`. When the user runs it, do not convert the document
again; at most confirm where the result landed.

Otherwise, when a Word document reaches you on its own — the user sends
`@name.docx` without a command, drags the file into the composer (the message then
carries a read-only copy under `$DSH_HOME/attachments/v1/files/...`), or asks in
ordinary language — convert it with the `word_to_markdown` tool:

- `docxPath`: the referenced path (a relative `@` path resolves from the workspace
  root) or the saved attachment path. Never assume the original file location
  still exists.
- `outputDir`: an **absolute** path to `docs` at the workspace root
  (`E:\Projects\WebStormProjects\deepseek-harness\docs`). The tool creates it.
- Leave `format` at its default. Pass `format: markdown` only when the user asks
  for output with no HTML at all, and say why when you do.
- Report the Markdown path and the extracted image count in one line, and repeat
  any warning the tool returned.

Do not copy the `.docx` into the workspace for the drag case: the attachment store
already keeps it read-only and durable. A legacy `.doc` cannot be converted — ask
for it to be saved as `.docx` first.

## This repository

This is a DeepSeek Harness **plugin** repository. Every plugin is a bundle under
`plugins/<name>/` with its own bilingual README pair; see [README.md](README.md) for
the layout, the install command, and the conventions a new plugin must follow.
