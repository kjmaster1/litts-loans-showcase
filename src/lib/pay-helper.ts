import { formatDollars } from "./format";

/**
 * Paying commission from the game's phone (owner, 2026-11-02). The phone's Litt's Loans card pays staff only through
 * ⋯ → Pay Employee (State ID, Amount, Comment): a Transfer from a business wallet to a personal one fails. The pay
 * sheet copies its rows as a list; the phone helper (a bookmarklet) fills the form from it and the person presses
 * Submit. Nothing here sends money.
 */

export const PAY_LIST_KIND = "litts-pay-sheet";

export type PhoneRow = { name: string; stateId: number; amount: number; pay: string; comment: string };

/** The pay sheet as the phone helper reads it. `id` changes whenever any row does, so ticks don't carry over. */
export function phoneList(rows: { name: string; stateId: number; owedCents: number; comment: string }[]): string {
  const list: PhoneRow[] = rows.map((r) => ({
    name: r.name,
    stateId: r.stateId,
    amount: Math.round(r.owedCents / 100),
    pay: formatDollars(r.owedCents),
    comment: r.comment,
  }));
  return JSON.stringify({ kind: PAY_LIST_KIND, id: fnv1a(JSON.stringify(list)), rows: list });
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** The phone helper as a bookmark's address. */
export function bookmarklet(): string {
  return `javascript:${encodeURIComponent(`(${phoneHelper.toString()})()`)}`;
}

/**
 * Runs on the phone page (game-fivem-ui.onx.gg). Serialised with toString(), so it must not use anything from outside
 * its own body. The form's fields are a `span` label and an `input` under one parent; the inputs are React-controlled,
 * so values go through the native setter plus an `input` event. Only the open form's labels are in the page. A person is ticked when Submit is pressed with the
 * form still holding what was filled; ticks are kept in that page's localStorage per list.
 */
export function phoneHelper(): void {
  type Row = { name: string; stateId: number; amount: number; pay: string; comment: string };
  type Saved = { id: string; rows: Row[]; paid: number[] };
  const STORE = "litts-pay";
  const KIND = "litts-pay-sheet";
  // The business wallet's number is on its card; the card's name heading gives way to the search box.
  const WALLET = "69811362";
  const host = window as unknown as { __littsPay?: { show: () => void } };
  if (host.__littsPay) return host.__littsPay.show();

  let saved: Saved | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORE) ?? "null");
  } catch {
    // Storage blocked or garbled: start with no list.
  }
  let current: Row | null = null;
  let note = "";
  let editing = !saved;

  const panel = document.createElement("div");
  panel.setAttribute("data-litts-pay", "");
  panel.style.cssText =
    "position:fixed;top:16px;left:16px;z-index:2147483647;width:380px;max-height:calc(100vh - 32px);overflow:auto;" +
    "background:#111827;color:#f9fafb;font:13px/1.4 system-ui,sans-serif;border:1px solid #374151;border-radius:10px;" +
    "padding:12px;box-shadow:0 10px 30px rgba(0,0,0,.5)";
  document.body.append(panel);

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, css?: string): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (css) e.style.cssText = css;
    return e;
  };
  const button = (text: string, onClick: () => void, primary = false) => {
    const b = el(
      "button",
      text,
      `cursor:pointer;border-radius:6px;padding:3px 10px;font:inherit;border:1px solid ${primary ? "#2563eb" : "#4b5563"};` +
        `background:${primary ? "#2563eb" : "transparent"};color:#f9fafb`,
    );
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  };
  const save = () => {
    try {
      localStorage.setItem(STORE, JSON.stringify(saved));
    } catch {
      // Storage blocked: ticks last until the page reloads.
    }
  };
  const visible = (e: Element) => !panel.contains(e) && (e as HTMLElement).getClientRects().length > 0;
  const plain = (s: string | null) => (s ?? "").replace(/[‘’]/g, "'").trim();
  // Since 2026-11-16 Pay Employee starts with an Employee dropdown and labels the box "... or State ID"; the helper
  // leaves the dropdown on "Select Employee" and fills the State ID box. The Transfer form's "... or Wallet ID" stays
  // "Wallet ID" after this, so it never passes for "State ID".
  const bare = (s: string | null) => plain(s).replace(/^(?:\.{2,}|…)\s*or\s+/i, "");
  const label = (text: string) => [...document.querySelectorAll("span")].find((s) => visible(s) && bare(s.textContent) === text);
  const field = (text: string) => label(text)?.parentElement?.parentElement?.querySelector("input") ?? null;
  const setValue = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  function load(text: string) {
    let list: { kind?: string; id?: string; rows?: Row[] };
    try {
      list = JSON.parse(text);
    } catch {
      note = "That isn't the list. Use “Copy list for the phone” on the Commissions page.";
      return render();
    }
    const rows = Array.isArray(list.rows) ? list.rows : [];
    const ok = rows.every(
      (r) =>
        typeof r.name === "string" && Number.isInteger(r.stateId) && r.stateId > 0 && Number.isInteger(r.amount) && r.amount > 0 &&
        typeof r.pay === "string" && typeof r.comment === "string",
    );
    if (list.kind !== KIND || typeof list.id !== "string" || !rows.length || !ok) {
      note = "That isn't the list. Use “Copy list for the phone” on the Commissions page.";
      return render();
    }
    saved = { id: list.id, rows, paid: saved?.id === list.id ? saved.paid : [] };
    save();
    current = null;
    editing = false;
    note = saved.paid.length ? `Same list as before: ${saved.paid.length} already ticked.` : "";
    render();
  }

  function fill(row: Row) {
    current = null;
    if (saved!.paid.includes(row.stateId)) {
      note = `${row.name} is already ticked as paid. Untick them first if that payment didn't go through.`;
    } else if (![...document.querySelectorAll("span")].some((s) => visible(s) && plain(s.textContent) === WALLET)) {
      note = `Open Wallet → the Litt's Loans card (${WALLET}) first.`;
    } else if ([...document.querySelectorAll("span")].some((s) => visible(s) && /Wallet ID/.test(s.textContent ?? ""))) {
      note = "This is the Transfer form, which can't pay a personal wallet. Cancel it and use ⋯ → Pay Employee.";
    } else {
      const inputs = [field("State ID"), field("Amount"), field("Comment")];
      if (inputs.some((i) => !i)) {
        note = "Open the card's ⋯ menu → Pay Employee, then click Fill again.";
      } else {
        const [id, amount, comment] = inputs as HTMLInputElement[];
        setValue(id, String(row.stateId));
        setValue(amount, String(row.amount));
        setValue(comment, row.comment);
        current = row;
        note = `Filled for ${row.name}. Check it, then press Submit on the phone.`;
      }
    }
    render();
  }

  document.addEventListener(
    "click",
    (e) => {
      const b = (e.target as Element | null)?.closest?.("button");
      if (!b || panel.contains(b) || !current || !saved) return;
      const text = plain(b.textContent);
      if (text === "Cancel") {
        note = `Cancelled: ${current.name} not paid.`;
        current = null;
        return render();
      }
      if (text !== "Submit") return;
      const values = [field("State ID")?.value, field("Amount")?.value, field("Comment")?.value];
      if (values[0] === String(current.stateId) && values[1] === String(current.amount) && values[2] === current.comment) {
        saved.paid.push(current.stateId);
        save();
        note = `Ticked ${current.name}. If the phone shows an error, untick them.`;
      } else {
        note = `The form was changed after it was filled, so ${current.name} wasn't ticked. Check the bank, then tick or fill again.`;
      }
      current = null;
      render();
    },
    true,
  );

  function render() {
    panel.replaceChildren();
    const head = el("div", undefined, "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px");
    head.append(el("strong", "Litt's Loans · commission pay", "font-size:14px"), button("×", () => (panel.style.display = "none")));
    panel.append(head);

    if (editing || !saved) {
      const area = el("textarea", undefined, "width:100%;height:80px;box-sizing:border-box;background:#1f2937;color:inherit;border:1px solid #4b5563;border-radius:6px;padding:6px;font:12px monospace");
      area.placeholder = "Paste the list from the Commissions page (Copy list for the phone)";
      area.setAttribute("aria-label", "Pay list");
      const actions = el("div", undefined, "display:flex;gap:6px;margin-top:6px");
      actions.append(button("Load list", () => load(area.value), true));
      if (saved) actions.append(button("Back", () => ((editing = false), render())));
      panel.append(area, actions);
    } else {
      const s = saved;
      const left = s.rows.filter((r) => !s.paid.includes(r.stateId));
      const top = el("div", undefined, "display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px");
      top.append(
        el("span", `${s.rows.length - left.length} of ${s.rows.length} paid`, "color:#9ca3af"),
        left.length ? button("Fill next", () => fill(left[0]), true) : el("span", "Everyone is paid", "color:#34d399"),
      );
      panel.append(top);
      const table = el("table", undefined, "width:100%;border-collapse:collapse");
      for (const r of s.rows) {
        const paid = s.paid.includes(r.stateId);
        const tr = el("tr", undefined, `border-top:1px solid #374151;${r === current ? "background:#1e3a8a" : ""}`);
        const who = el("td", undefined, "padding:5px 4px");
        who.append(el("div", r.name), el("div", `State ID ${r.stateId}`, "color:#9ca3af;font-size:12px"));
        const act = el("td", undefined, "padding:5px 4px;text-align:right;white-space:nowrap");
        if (paid) {
          act.append(
            el("span", "✓ Paid ", "color:#34d399"),
            button("Untick", () => {
              s.paid = s.paid.filter((x) => x !== r.stateId);
              save();
              note = `${r.name} unticked.`;
              render();
            }),
          );
        } else act.append(button("Fill", () => fill(r)));
        tr.append(who, el("td", r.pay, "padding:5px 4px;text-align:right;font-variant-numeric:tabular-nums"), act);
        table.append(tr);
      }
      panel.append(table);
      const foot = el("div", undefined, "display:flex;gap:6px;margin-top:8px");
      foot.append(button("Paste a new list", () => ((editing = true), (note = ""), render())));
      panel.append(foot);
    }
    if (note) panel.append(el("p", note, "margin:8px 0 0;color:#fcd34d"));
  }

  host.__littsPay = { show: () => ((panel.style.display = ""), render()) };
  render();
}
