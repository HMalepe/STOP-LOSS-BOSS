/**
 * R6.5 / ADR-0009: where did each entry end up? One shared rule for every broker so the mock and MetaApi can't drift.
 * Precedence: a position beats a pending order beats "still in flight" beats "not found".
 */
import type { PendingOrder, Position } from "@/domain/types";
import type { Reconciled } from "./BrokerProvider";

type NonEmpty = [string, ...string[]];

function indexBy(
  items: readonly { readonly id: string; readonly clientId?: string }[],
): Map<string, NonEmpty> {
  const out = new Map<string, NonEmpty>();
  for (const item of items) {
    if (item.clientId === undefined) continue;
    const ids = out.get(item.clientId);
    if (ids === undefined) out.set(item.clientId, [item.id]);
    else ids.push(item.id);
  }
  return out;
}

export function reconcileFrom(
  clientIds: readonly string[],
  positions: readonly Position[],
  orders: readonly PendingOrder[],
  inFlight: ReadonlySet<string>,
): ReadonlyMap<string, Reconciled> {
  const byPos = indexBy(positions);
  const byOrder = indexBy(orders);
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
