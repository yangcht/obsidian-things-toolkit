import { ItemView, Notice, WorkspaceLeaf } from "obsidian";

import type ThingsToolkitPlugin from "./index";
import { getMoment, type MomentLike } from "./moment";
import { ReviewDraftStore } from "./reviewDrafts";
import { getScrollTopToReveal } from "./reviewScroll";
import { DayReviewRating } from "./settings";

export const VIEW_TYPE_THINGS_TOOLKIT_REVIEW = "things-toolkit-review";

const RATING_LABELS: Record<DayReviewRating, string> = {
  good: "Good day",
  steady: "Steady day",
  improve: "Needs improvement",
};

export interface ReviewViewDisplayOptions {
  revealSelectedDate?: boolean;
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

export class ThingsToolkitReviewView extends ItemView {
  private plugin: ThingsToolkitPlugin;
  private readonly moment = getMoment();
  private readonly drafts = new ReviewDraftStore();
  private reflectionTextareaEl: HTMLTextAreaElement | null = null;
  private renderedReflectionDateKey: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ThingsToolkitPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_THINGS_TOOLKIT_REVIEW;
  }

  getDisplayText(): string {
    return "Things Toolkit review";
  }

  getIcon(): string {
    return "calendar-check";
  }

  async onOpen(): Promise<void> {
    try {
      await this.plugin.refreshDailyReviewStateFromVault();
    } catch (err) {
      console.error("[Things Toolkit] Failed to refresh review state", err);
    }

    this.plugin.updateStatusBar();
    this.display({ revealSelectedDate: true });
  }

  display(options: ReviewViewDisplayOptions = {}): void {
    const { contentEl } = this;
    const previousCalendarScrollTop =
      contentEl.querySelector<HTMLElement>(
        ".things-toolkit-review-calendar-region"
      )?.scrollTop ?? 0;
    const previousDetailScrollTop =
      contentEl.querySelector<HTMLElement>(
        ".things-toolkit-review-detail-region"
      )?.scrollTop ?? 0;
    const previousDateKey = this.renderedReflectionDateKey;

    let focusedSelection: {
      dateKey: string;
      end: number | null;
      start: number | null;
    } | null = null;

    if (this.reflectionTextareaEl && this.renderedReflectionDateKey) {
      const savedReflection =
        this.plugin.options.dailyReviews[this.renderedReflectionDateKey]
          ?.reflection;
      this.drafts.setDraft(
        this.renderedReflectionDateKey,
        this.reflectionTextareaEl.value,
        savedReflection
      );

      if (
        typeof document !== "undefined" &&
        document.activeElement === this.reflectionTextareaEl
      ) {
        focusedSelection = {
          dateKey: this.renderedReflectionDateKey,
          start: this.reflectionTextareaEl.selectionStart,
          end: this.reflectionTextareaEl.selectionEnd,
        };
      }
    }

    this.reflectionTextareaEl = null;
    this.renderedReflectionDateKey = null;

    contentEl.empty();
    contentEl.addClass("things-toolkit-review");

    const calendarRegionEl = contentEl.createDiv(
      "things-toolkit-review-calendar-region"
    );
    calendarRegionEl.setAttribute("role", "region");
    calendarRegionEl.setAttribute(
      "aria-label",
      "Things review summary and calendar"
    );
    calendarRegionEl.tabIndex = 0;

    this.renderSummary(calendarRegionEl);
    this.renderCalendar(calendarRegionEl);

    const detailRegionEl = contentEl.createDiv(
      "things-toolkit-review-detail-region"
    );
    detailRegionEl.setAttribute("role", "region");
    detailRegionEl.setAttribute("aria-label", "Selected day review");
    this.renderSelectedDay(detailRegionEl);

    calendarRegionEl.scrollTop = previousCalendarScrollTop;
    if (options.revealSelectedDate) {
      this.revealSelectedDate(calendarRegionEl);
    }

    if (previousDateKey && previousDateKey === this.renderedReflectionDateKey) {
      detailRegionEl.scrollTop = previousDetailScrollTop;
    }

    if (
      focusedSelection &&
      focusedSelection.dateKey === this.renderedReflectionDateKey &&
      this.reflectionTextareaEl !== null
    ) {
      const textarea = this.reflectionTextareaEl as HTMLTextAreaElement;
      textarea.focus({ preventScroll: true });
      if (focusedSelection.start !== null && focusedSelection.end !== null) {
        const maxOffset = textarea.value.length;
        textarea.setSelectionRange(
          Math.min(focusedSelection.start, maxOffset),
          Math.min(focusedSelection.end, maxOffset)
        );
      }
    }
  }

  private revealSelectedDate(calendarRegionEl: HTMLElement): void {
    const selectedDateEl =
      calendarRegionEl.querySelector<HTMLElement>(
        ".things-toolkit-review-day.is-selected"
      );

    if (!selectedDateEl) {
      return;
    }

    const viewport = calendarRegionEl.getBoundingClientRect();
    const selectedDate = selectedDateEl.getBoundingClientRect();
    calendarRegionEl.scrollTop = getScrollTopToReveal(
      calendarRegionEl.scrollTop,
      viewport,
      selectedDate
    );
  }

  private renderSummary(containerEl: HTMLElement): void {
    const today = this.moment().format("YYYY-MM-DD");
    const todayCount = this.plugin.getTaskCountForDay(today);
    const weeklyCount = this.getRecentTaskTotal(7);
    const streak = this.plugin.getCurrentCompletionStreak();

    const summaryEl = containerEl.createDiv("things-toolkit-review-summary");
    this.addSummaryMetric(summaryEl, String(todayCount), "Today");
    this.addSummaryMetric(summaryEl, String(weeklyCount), "Last 7 days");
    this.addSummaryMetric(summaryEl, String(streak), "Current streak");
  }

  private addSummaryMetric(
    containerEl: HTMLElement,
    value: string,
    label: string
  ): void {
    const metricEl = containerEl.createDiv("things-toolkit-review-metric");
    metricEl.createDiv({
      cls: "things-toolkit-review-metric-value",
      text: value,
    });
    metricEl.createDiv({
      cls: "things-toolkit-review-metric-label",
      text: label,
    });
  }

  private renderCalendar(containerEl: HTMLElement): void {
    const dates = this.getRecentDates(this.plugin.getReviewWindowDayCount());
    let startDate = dates[0];
    let endDate = dates[dates.length - 1];
    const parsedSelectedDate = this.moment(
      this.plugin.getSelectedReviewDate(),
      "YYYY-MM-DD",
      true
    );
    const selectedDate = parsedSelectedDate.isValid()
      ? parsedSelectedDate
      : this.moment().startOf("day");

    containerEl.createEl("h4", { text: "Review calendar" });

    if (selectedDate.isSame(startDate, "month") && selectedDate.isBefore(startDate, "day")) {
      startDate = selectedDate.clone();
    }
    if (selectedDate.isSame(endDate, "month") && selectedDate.isAfter(endDate, "day")) {
      endDate = selectedDate.clone();
    }

    containerEl.createDiv({
      cls: "things-toolkit-review-range",
      text: `${startDate.format("MMM D, YYYY")} - ${endDate.format("MMM D, YYYY")}`,
    });

    if (selectedDate.isBefore(startDate, "day")) {
      this.renderMonth(
        containerEl,
        selectedDate.clone().startOf("month"),
        selectedDate.clone().startOf("month"),
        selectedDate.clone().endOf("month")
      );
    }

    for (
      let month = startDate.clone().startOf("month");
      month.isSameOrBefore(endDate, "month");
      month.add(1, "month")
    ) {
      this.renderMonth(containerEl, month.clone(), startDate, endDate);
    }

    if (selectedDate.isAfter(endDate, "day")) {
      this.renderMonth(
        containerEl,
        selectedDate.clone().startOf("month"),
        selectedDate.clone().startOf("month"),
        selectedDate.clone().endOf("month")
      );
    }
  }

  private renderSelectedDay(containerEl: HTMLElement): void {
    const parsedDate = this.moment(
      this.plugin.getSelectedReviewDate(),
      "YYYY-MM-DD",
      true
    );
    const date = parsedDate.isValid()
      ? parsedDate
      : this.moment().startOf("day");
    const dateKey = date.format("YYYY-MM-DD");
    const review = this.plugin.options.dailyReviews[dateKey] || {};
    const stat = this.plugin.options.dailyStats[dateKey];
    const taskCount = stat?.taskCount || 0;
    const detailEl = containerEl.createDiv("things-toolkit-review-detail");

    detailEl.createEl("h4", {
      text: date.format("dddd, MMM D, YYYY"),
    });
    detailEl.createDiv({
      cls: "things-toolkit-review-detail-count",
      text: `${taskCount} completed ${pluralize(taskCount, "task", "tasks")} • Week ${date.isoWeek()}`,
    });

    const contextEl = detailEl.createDiv("things-toolkit-review-context");
    this.addContextMetric(
      contextEl,
      String(this.getWeekTotal(date)),
      `Week ${date.isoWeek()} total`
    );
    this.addContextMetric(
      contextEl,
      String(this.getMonthTotal(date)),
      `${date.format("MMM")} total`
    );
    this.addContextMetric(
      contextEl,
      String(this.getMonthActiveDays(date)),
      "Active days"
    );

    const ratingEl = detailEl.createDiv("things-toolkit-review-rating");
    (Object.keys(RATING_LABELS) as DayReviewRating[]).forEach((rating) => {
      const isActive = review.rating === rating;
      const buttonEl = ratingEl.createEl("button", {
        text: RATING_LABELS[rating],
      });
      buttonEl.setAttribute("aria-pressed", String(isActive));
      if (isActive) {
        buttonEl.addClass("is-active");
      }
      buttonEl.addEventListener("click", () => {
        const nextRating = isActive ? undefined : rating;
        if (this.reflectionTextareaEl) {
          this.drafts.setDraft(
            dateKey,
            this.reflectionTextareaEl.value,
            review.reflection
          );
        }
        void this.plugin
          .writeDayReview(dateKey, { rating: nextRating })
          .catch((err) => {
            console.error("[Things Toolkit] Failed to save day rating", err);
            new Notice("Failed to save Things review");
          });
      });
    });

    const textareaEl = detailEl.createEl("textarea", {
      cls: "things-toolkit-review-reflection",
      attr: {
        placeholder:
          "One short note about what worked, what slipped, or what to adjust tomorrow.",
      },
    });
    textareaEl.value = this.drafts.getEditorValue(dateKey, review.reflection);
    this.reflectionTextareaEl = textareaEl;
    this.renderedReflectionDateKey = dateKey;

    const actionsEl = detailEl.createDiv("things-toolkit-review-actions");
    const saveButtonEl = actionsEl.createEl("button", {
      text: "Save reflection",
    });
    const openNoteButtonEl = actionsEl.createEl("button", {
      text: "Open daily note",
    });
    const draftStatusEl = actionsEl.createSpan({
      cls: "things-toolkit-review-draft-status",
    });

    const syncDraftIndicator = () => {
      const hasDraft = this.drafts.hasUnsavedDraft(dateKey, review.reflection);
      saveButtonEl.toggleClass("mod-cta", hasDraft);
      draftStatusEl.setText(hasDraft ? "Unsaved changes" : "");
    };
    syncDraftIndicator();

    const saveReflection = async () => {
      const rawValue = textareaEl.value;
      this.drafts.setDraft(dateKey, rawValue, review.reflection);
      saveButtonEl.disabled = true;

      try {
        await this.plugin.writeDayReview(dateKey, {
          reflection: rawValue.trim(),
        });
        this.drafts.clearDraftIfUnchanged(dateKey, rawValue);
        new Notice("Things review saved");
        if (rawValue !== rawValue.trim()) {
          this.display();
        }
      } catch (err) {
        console.error("[Things Toolkit] Failed to save reflection", err);
        saveButtonEl.disabled = false;
        new Notice("Failed to save Things review");
      }
    };

    textareaEl.addEventListener("input", () => {
      this.drafts.setDraft(dateKey, textareaEl.value, review.reflection);
      syncDraftIndicator();
    });

    textareaEl.addEventListener("keydown", (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void saveReflection();
      }
    });

    saveButtonEl.addEventListener("click", () => {
      void saveReflection();
    });

    openNoteButtonEl.addEventListener("click", () => {
      void this.plugin.openDailyNote(dateKey).catch((err) => {
        console.error("[Things Toolkit] Failed to open daily note", err);
        new Notice("Failed to open daily note");
      });
    });
  }

  private renderMonth(
    containerEl: HTMLElement,
    month: MomentLike,
    startDate: MomentLike,
    endDate: MomentLike
  ): void {
    const monthEl = containerEl.createDiv("things-toolkit-review-month");
    const summary = this.getMonthSummary(month);
    const headerEl = monthEl.createDiv("things-toolkit-review-month-header");
    headerEl.createDiv({
      cls: "things-toolkit-review-month-title",
      text: month.format("MMMM YYYY"),
    });
    headerEl.createDiv({
      cls: "things-toolkit-review-month-meta",
      text: `${summary.total} ${pluralize(summary.total, "task", "tasks")} • ${summary.activeDays} active ${pluralize(summary.activeDays, "day", "days")} • best ${summary.bestDay}`,
    });

    const gridEl = monthEl.createDiv("things-toolkit-review-calendar-grid");
    ["Wk", "M", "T", "W", "T", "F", "S", "S"].forEach((label) => {
      gridEl.createDiv({
        cls: "things-toolkit-review-calendar-heading",
        text: label,
      });
    });

    const monthEnd = month.clone().endOf("month").startOf("day");
    const finalWeekStart = monthEnd.clone().startOf("isoWeek");
    for (
      let weekStart = month.clone().startOf("isoWeek");
      weekStart.isSameOrBefore(finalWeekStart, "day");
      weekStart.add(1, "week")
    ) {
      gridEl.createDiv({
        cls: "things-toolkit-review-week-number",
        text: String(weekStart.isoWeek()),
      });

      for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
        const date = weekStart.clone().add(dayOffset, "days");
        if (
          !date.isSame(month, "month") ||
          date.isBefore(startDate, "day") ||
          date.isAfter(endDate, "day")
        ) {
          gridEl.createDiv("things-toolkit-review-day-spacer");
        } else {
          this.renderCalendarDay(gridEl, date);
        }
      }
    }
  }

  private renderCalendarDay(containerEl: HTMLElement, date: MomentLike): void {
    const dateKey = date.format("YYYY-MM-DD");
    const count = this.plugin.getTaskCountForDay(dateKey);
    const review = this.plugin.options.dailyReviews[dateKey];
    const isSelected = dateKey === this.plugin.getSelectedReviewDate();
    const buttonEl = containerEl.createEl("button", {
      cls: "things-toolkit-review-day",
    });
    buttonEl.setAttribute(
      "aria-label",
      `${date.format("MMM D, YYYY")}: ${count} ${pluralize(count, "task", "tasks")}, week ${date.isoWeek()}`
    );

    if (isSelected) {
      buttonEl.addClass("is-selected");
      buttonEl.setAttribute("aria-current", "date");
    }
    if (review?.rating) {
      buttonEl.addClass(`is-${review.rating}`);
    }
    if (review?.reflection) {
      buttonEl.addClass("has-reflection");
    }
    if (count > 0) {
      buttonEl.addClass("has-tasks");
    }

    buttonEl.createDiv({
      cls: "things-toolkit-review-day-number",
      text: date.format("D"),
    });
    buttonEl.createDiv({
      cls: "things-toolkit-review-day-count",
      text: String(count),
    });

    buttonEl.addEventListener("click", () => {
      void this.plugin
        .selectReviewDate(dateKey, { openDailyNote: true })
        .catch((err) => {
          console.error("[Things Toolkit] Failed to open daily note", err);
          new Notice("Failed to open daily note");
        });
    });
  }

  private addContextMetric(
    containerEl: HTMLElement,
    value: string,
    label: string
  ): void {
    const metricEl = containerEl.createDiv("things-toolkit-review-context-metric");
    metricEl.createDiv({
      cls: "things-toolkit-review-context-value",
      text: value,
    });
    metricEl.createDiv({
      cls: "things-toolkit-review-context-label",
      text: label,
    });
  }

  private getRecentDates(dayCount: number): MomentLike[] {
    const end = this.moment().startOf("day");
    const start = end.clone().subtract(dayCount - 1, "days");
    const dates: MomentLike[] = [];
    for (let date = start; date.isSameOrBefore(end); date.add(1, "day")) {
      dates.push(date.clone());
    }
    return dates;
  }

  private getRecentTaskTotal(dayCount: number): number {
    return this.getRecentDates(dayCount).reduce(
      (sum, date) => sum + this.plugin.getTaskCountForDay(date.format("YYYY-MM-DD")),
      0
    );
  }

  private getWeekTotal(date: MomentLike): number {
    return this.sumDateRange(
      date.clone().startOf("isoWeek"),
      date.clone().endOf("isoWeek")
    );
  }

  private getMonthTotal(date: MomentLike): number {
    return this.sumDateRange(
      date.clone().startOf("month"),
      date.clone().endOf("month")
    );
  }

  private getMonthActiveDays(date: MomentLike): number {
    const end = date.clone().endOf("month");
    let activeDays = 0;
    for (
      let day = date.clone().startOf("month");
      day.isSameOrBefore(end, "day");
      day.add(1, "day")
    ) {
      if (this.plugin.getTaskCountForDay(day.format("YYYY-MM-DD")) > 0) {
        activeDays++;
      }
    }
    return activeDays;
  }

  private getMonthSummary(month: MomentLike): {
    activeDays: number;
    bestDay: string;
    total: number;
  } {
    const end = month.clone().endOf("month");
    let activeDays = 0;
    let bestCount = 0;
    let bestDay = "0";
    let total = 0;

    for (
      let day = month.clone().startOf("month");
      day.isSameOrBefore(end, "day");
      day.add(1, "day")
    ) {
      const count = this.plugin.getTaskCountForDay(day.format("YYYY-MM-DD"));
      total += count;
      if (count > 0) {
        activeDays++;
      }
      if (count > bestCount) {
        bestCount = count;
        bestDay = `${day.format("MMM D")} (${count})`;
      }
    }

    return { activeDays, bestDay, total };
  }

  private sumDateRange(start: MomentLike, end: MomentLike): number {
    let total = 0;
    for (
      let date = start.clone().startOf("day");
      date.isSameOrBefore(end, "day");
      date.add(1, "day")
    ) {
      total += this.plugin.getTaskCountForDay(date.format("YYYY-MM-DD"));
    }
    return total;
  }
}
