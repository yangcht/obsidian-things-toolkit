import { MarkdownView } from "obsidian";
import type { App, Editor, TFile } from "obsidian";

type MarkdownViewWithEditor = MarkdownView & {
  editor?: Editor;
};

function isMarkdownViewWithEditor(view: unknown): view is MarkdownViewWithEditor {
  return view instanceof MarkdownView;
}

export function getEditorForFile(app: App, file: TFile): Editor | null {
  const activeView = app.workspace.getActiveViewOfType?.(MarkdownView);
  if (
    activeView &&
    isMarkdownViewWithEditor(activeView) &&
    activeView.file === file &&
    activeView.editor
  ) {
    return activeView.editor;
  }

  let editor: Editor | null = null;

  app.workspace.iterateAllLeaves((leaf) => {
    const { view } = leaf;

    if (isMarkdownViewWithEditor(view) && view.file === file && view.editor) {
      editor = view.editor;
    }
  });

  return editor;
}