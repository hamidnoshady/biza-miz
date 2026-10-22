import { describe, expect, it } from "vitest";
import {
  canKitchenBump,
  canMarkServed,
  canTransitionItemStatus,
  isTicketLate,
  isKitchenOrderReady,
  ticketAgeMinutes,
} from "./order-item-status";

describe("canTransitionItemStatus", () => {
  it("allows the forward chain", () => {
    expect(canTransitionItemStatus("pending", "sent")).toBe(true);
    expect(canTransitionItemStatus("sent", "preparing")).toBe(true);
    expect(canTransitionItemStatus("preparing", "ready")).toBe(true);
    expect(canTransitionItemStatus("ready", "served")).toBe(true);
  });
  it("allows voiding from any non-terminal state", () => {
    expect(canTransitionItemStatus("pending", "voided")).toBe(true);
    expect(canTransitionItemStatus("sent", "voided")).toBe(true);
    expect(canTransitionItemStatus("preparing", "voided")).toBe(true);
    expect(canTransitionItemStatus("ready", "voided")).toBe(true);
  });
  it("rejects skipping steps or moving backwards", () => {
    expect(canTransitionItemStatus("sent", "ready")).toBe(false);
    expect(canTransitionItemStatus("ready", "sent")).toBe(false);
    expect(canTransitionItemStatus("served", "ready")).toBe(false);
  });
  it("rejects any transition out of a terminal state", () => {
    expect(canTransitionItemStatus("served", "voided")).toBe(false);
    expect(canTransitionItemStatus("voided", "sent")).toBe(false);
  });
});

describe("canKitchenBump", () => {
  it("only allows sent->preparing and preparing->ready", () => {
    expect(canKitchenBump("sent", "preparing")).toBe(true);
    expect(canKitchenBump("preparing", "ready")).toBe(true);
    expect(canKitchenBump("pending", "sent")).toBe(false);
    expect(canKitchenBump("ready", "served")).toBe(false);
  });
});

describe("canMarkServed", () => {
  it("only allows ready->served", () => {
    expect(canMarkServed("ready", "served")).toBe(true);
    expect(canMarkServed("preparing", "served")).toBe(false);
    expect(canMarkServed("sent", "ready")).toBe(false);
  });
});

describe("isKitchenOrderReady", () => {
  it("ignores voided lines but waits for every remaining line", () => {
    expect(isKitchenOrderReady(["ready", "voided"])).toBe(true);
    expect(isKitchenOrderReady(["ready", "served", "voided"])).toBe(true);
    expect(isKitchenOrderReady(["ready", "sent", "voided"])).toBe(false);
  });

  it("does not announce empty or all-voided orders as ready", () => {
    expect(isKitchenOrderReady([])).toBe(false);
    expect(isKitchenOrderReady(["voided", "voided"])).toBe(false);
  });
});

describe("ticket aging", () => {
  const sentAt = Date.UTC(2026, 0, 1, 12, 0, 0);
  it("computes elapsed minutes", () => {
    expect(ticketAgeMinutes(sentAt, sentAt)).toBe(0);
    expect(ticketAgeMinutes(sentAt, sentAt + 5 * 60_000)).toBe(5);
  });
  it("flags late tickets at/after the threshold, not before", () => {
    expect(isTicketLate(sentAt, sentAt + 9 * 60_000, 10)).toBe(false);
    expect(isTicketLate(sentAt, sentAt + 10 * 60_000, 10)).toBe(true);
    expect(isTicketLate(sentAt, sentAt + 15 * 60_000)).toBe(true);
  });
  it("never returns a negative age for clock skew", () => {
    expect(ticketAgeMinutes(sentAt, sentAt - 60_000)).toBe(0);
  });
});
