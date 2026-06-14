import { ItemView, Notice, WorkspaceLeaf } from "obsidian";

import type ThingsToolkitPlugin from "./index";
import { getMoment, type MomentLike } from "./moment";
import { DayReviewRating } from "./settings";

export const VIEW_TYPE_THINGS_TOOLKIT_REVIEW = "things-toolkit-review";

const RATING_LABELS: Record<DayReviewRating, string> = {
  good: "Good day",
  steady: "Steady day",
  improve: "Needs improvement",
};

export class ThingsToolkitReviewView extends ItemView {
  private plugin: ThingsToolkitPlugin;
  private selectedDate: string;
  private readonly moment = getMoment();

  constructor(leaf: WorkspaceLeaf, plugin: ThingsToolkitPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.selectedDate = this.moment().format("YYYY-MM-DD");
  }

  getViewType(): string {
    return VIEW_TYPE_THINGS_TOOLKIT_REVIEW;
  }

  getDisplayText(): string {
    return "Things toolkit review";
  }

  getIcon(): string {
    return "calendar-check";
  }

  async onOpen(): Promise<void> {
    if (this.plugin.isSyncSupported()) {
      await this.plugin.refreshRecentDailyStats();
    }
    this.display();
  }

  display(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("things-toolkit-review");

    this.renderSummary(contentEl);
    this.renderCalendar(contentEl);
    this.renderSelectedDay(contentEl);
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
    const startDate = dates[0];
    const endDate = dates[dates.length - 1];

    containerEl.createEl("h4", { text: "Review calendar" });
    containerEl.createDiv({
      cls: "things-toolkit-review-range",
      text: `${startDate.format("MMM D, YYYY")} - ${endDate.format("MMM D, YYYY")}`,
    });

    for (
      let month = startDate.clone().startOf("month");
      month.isSameOrBefore(endDate, "month");
      month.add(1, "month")
    ) {
      this.renderMonth(containerEl, month.clone(), startDate, endDate);
    }
  }

  private renderSelectedDay(containerEl: HTMLElement): void {
    const dateKey = this.selectedDate;
    const date = this.moment(dateKey, "YYYY-MM-DD");
    const review = this.plugin.options.dailyReviews[dateKey] || {};
    const stat = this.plugin.options.dailyStats[dateKey];
    const detailEl = containerEl.createDiv("things-toolkit-review-detail");

    detailEl.createEl("h4", {
      text: date.format("dddd, MMM D, YYYY"),
    });
    detailEl.createDiv({
      cls: "things-toolkit-review-detail-count",
      text: `${stat?.taskCount || 0} completed tasks • Week ${date.isoWeek()}`,
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
      const buttonEl = ratingEl.createEl("button", {
        text: RATING_LABELS[rating],
      });
      if (review.rating === rating) {
        buttonEl.addClass("is-active");
      }
      buttonEl.addEventListener("click", () => {
        void this.plugin.writeDayReview(dateKey, { rating }).then(() => {
          this.display();
        });
      });
    });

    const textareaEl = detailEl.createEl("textarea", {
      cls: "things-toolkit-review-reflection",
      attr: {
        placeholder: "One short note about what worked, what slipped, or what to adjust tomorrow.",
      },
    });
    textareaEl.value = review.reflection || "";

    const actionsEl = detailEl.createDiv("things-toolkit-review-actions");
    actionsEl
      .createEl("button", { text: "Save reflection" })
      .addEventListener("click", () => {
        void this.plugin.writeDayReview(dateKey, {
          reflection: textareaEl.value.trim(),
        }).then(() => {
          new Notice("Things review saved");
          this.display();
        });
      });

    actionsEl
      .createEl("button", { text: "Open daily note" })
      .addEventListener("click", () => {
        void this.plugin.openDailyNote(dateKey);
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
      text: `${summary.total} tasks • ${summary.activeDays} active days • best ${summary.bestDay}`,
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
    const buttonEl = containerEl.createEl("button", {
      cls: "things-toolkit-review-day",
    });
    buttonEl.setAttribute(
      "aria-label",
      `${date.format("MMM D, YYYY")}: ${count} tasks, week ${date.isoWeek()}`
    );

    if (dateKey === this.selectedDate) {
      buttonEl.addClass("is-selected");
    }
    if (review?.rating) {
      buttonEl.addClass(`is-${review.rating}`);
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
      this.selectedDate = dateKey;
      this.display();
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
