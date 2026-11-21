export class ReviewDraftStore {
  private readonly drafts = new Map<string, string>();

  setDraft(dateKey: string, value: string, savedReflection?: string): void {
    const baseline = savedReflection ?? "";
    if (value === baseline) {
      this.drafts.delete(dateKey);
      return;
    }

    this.drafts.set(dateKey, value);
  }

  getEditorValue(dateKey: string, savedReflection?: string): string {
    const draft = this.drafts.get(dateKey);
    if (draft !== undefined) {
      return draft;
    }

    return savedReflection ?? "";
  }

  hasUnsavedDraft(dateKey: string, savedReflection?: string): boolean {
    const draft = this.drafts.get(dateKey);
    if (draft === undefined) {
      return false;
    }

    return draft.trim() !== (savedReflection ?? "").trim();
  }

  clearDraftIfUnchanged(dateKey: string, expectedValue: string): void {
    const current = this.drafts.get(dateKey);
    if (current === undefined || current === expectedValue) {
      this.drafts.delete(dateKey);
    }
  }

  clear(dateKey?: string): void {
    if (dateKey === undefined) {
      this.drafts.clear();
      return;
    }

    this.drafts.delete(dateKey);
  }
}
