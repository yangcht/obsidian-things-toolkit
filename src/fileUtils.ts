import { App, Editor, MarkdownView, TFile, WorkspaceLeaf } from "obsidian";

export function getEditorForFile(app: App, file: TFile): Editor | null {
  let editor: Editor | null = null;

  app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
    const view = leaf.view;

    if (view instanceof MarkdownView && view.file === file) {
      editor = view.editor;
    }
  });

  return editor;
}

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
