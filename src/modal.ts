import { App, Modal } from "obsidian";

interface IConfirmationDialogParams {
  cta: string;
  onAccept: () => Promise<void>;
  onCancel?: () => void;
  text: string;
  title: string;
}

export class ConfirmationModal extends Modal {
  private config: IConfirmationDialogParams;
  private accepted = false;
  private buttonContainerEl: HTMLElement;

  constructor(app: App, config: IConfirmationDialogParams) {
    super(app);
    this.config = config;

    const { cta, onAccept, text, title } = config;

    this.containerEl.addClass("mod-confirmation");
    this.titleEl.setText(title);
    this.contentEl.setText(text);

    this.buttonContainerEl = this.modalEl.createDiv("modal-button-container");

    const acceptBtnEl = this.buttonContainerEl.createEl("button", {
      cls: "mod-cta",
      text: cta,
    });
    acceptBtnEl.addEventListener("click", (event: MouseEvent) => {
      event.preventDefault();
      this.accepted = true;
      this.close();
      void onAccept();
    });

    const cancelBtnEl = this.buttonContainerEl.createEl("button", {
      text: "Never mind",
    });
    cancelBtnEl.addEventListener("click", (event: MouseEvent) => {
      event.preventDefault();
      this.close();
    });
  }

  onClose(): void {
    if (!this.accepted) {
      this.config.onCancel?.();
    }
  }
}
