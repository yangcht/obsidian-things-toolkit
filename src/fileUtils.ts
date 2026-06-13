import { Editor } from "codemirror";
import { App, MarkdownView, TFile, WorkspaceLeaf } from "obsidian";

type MarkdownEditor = Editor & {
  replaceRange: Editor["replaceRange"];
};

type MarkdownViewWithEditor = MarkdownView & {
  editor?: MarkdownEditor;
  sourceMode?: { cmEditor?: MarkdownEditor };
};

function isMarkdownViewWithEditor(view: unknown): view is MarkdownViewWithEditor {
  return view instanceof MarkdownView;
}

export function getEditorForFile(app: App, file: TFile): MarkdownEditor | null {
  let editor: MarkdownEditor | null = null;
  app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
    const { view } = leaf;
    if (isMarkdownViewWithEditor(view) && view.file === file) {
      editor = view.editor ?? view.sourceMode?.cmEditor ?? null;
    }
  });
  return editor;
}
