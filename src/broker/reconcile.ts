/**
 * R6.5 / ADR-0009: where did each entry end up? One shared rule for every broker so the mock and MetaApi can't drift.
 * Precedence: a position beats a pending order beats "still in flight" beats "not found".
 */
import type { PendingOrder, Position } from "@/domain/types";
import type { Reconciled } from "./BrokerProvider";

export function reconcileFrom(
  clientIds: readonly string[],
  positions: readonly Position[],
  orders: readonly PendingOrder[],
  inFlight: ReadonlySet<string>,
): ReadonlyMap<string, Reconciled> {
  const byPos = new Map<string, string[]>();
  for (const p of positions) {
    if (p.clientId !== undefined) byPos.set(p.clientId, [...(byPos.get(p.clientId) ?? []), p.id]);
  }
  const byOrder = new Map<string, string[]>();
  for (const o of orders) {
    if (o.clientId !== undefined) byOrder.set(o.clientId, [...(byOrder.get(o.clientId) ?? []), o.id]);
  }

  const out = new Map<string, Reconciled>();
  for (const id of clientIds) {
    const pos = byPos.get(id);
    const ord = byOrder.get(id);
    out.set(
      id,
      pos !== undefined
        ? { status: "position", positionIds: pos }
        : ord !== undefined
          ? { status: "order", orderIds: ord }
          : inFlight.has(id)
            ? { status: "inFlight" }
            : { status: "notFound" },
    );
  }
  return out;
}
