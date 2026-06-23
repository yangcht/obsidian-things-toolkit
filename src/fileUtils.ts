import { MarkdownView } from "obsidian";
import type { App, Editor, TFile } from "obsidian";

type MarkdownViewWithEditor = MarkdownView & {
  editor?: Editor;
};

function isMarkdownViewWithEditor(view: unknown): view is MarkdownViewWithEditor {
  return view instanceof MarkdownView;
}

export function getEditorForFile(app: App, file: TFile): Editor | null {
  let editor: Editor | null = null;

  app.workspace.iterateAllLeaves((leaf) => {
    const { view } = leaf;

    if (isMarkdownViewWithEditor(view) && view.file === file) {
      editor = view.editor ?? null;
    }
  });

  return editor;
}