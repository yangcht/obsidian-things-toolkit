import { Editor } from "codemirror";
import { App, MarkdownView, TFile } from "obsidian";

type MarkdownEditor = Editor & {
  replaceRange: Editor["replaceRange"];
};

export function getEditorForFile(app: App, file: TFile): MarkdownEditor | null {
  let editor = null;
  app.workspace.iterateAllLeaves((leaf) => {
    if (leaf.view instanceof MarkdownView && leaf.view.file === file) {
      const view = leaf.view as MarkdownView & {
        editor?: MarkdownEditor;
        sourceMode?: { cmEditor?: MarkdownEditor };
      };
      editor = view.editor || view.sourceMode?.cmEditor;
    }
  });
  return editor;
}
