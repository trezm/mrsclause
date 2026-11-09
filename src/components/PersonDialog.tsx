import { useState, type FormEvent } from "react";
import { api } from "../api";
import { centsToInput, parseMoney } from "../format";
import { useApp } from "../state";
import { Field, Modal } from "./ui";

export function PersonDialog({ personId, onClose }: { personId: string; onClose: () => void }) {
  const { data, act } = useApp();
  const person = personId === "new" ? null : (data.recipients.find((r) => r.id === personId) ?? null);
  const [name, setName] = useState(person?.name ?? "");
  const [budget, setBudget] = useState(centsToInput(person?.budgetCents));
  const [notes, setNotes] = useState(person?.notes ?? "");

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim()) return;
    const payload = { name: name.trim(), budgetCents: parseMoney(budget), notes: notes.trim() || null };
    const okay = await act(() => (person ? api.patch(`/recipients/${person.id}`, payload) : api.post("/recipients", payload)));
    if (okay) onClose();
  };

  return (
    <Modal
      title={person ? `Edit ${person.name}` : "Add a person"}
      onClose={onClose}
      footer={
        <>
          {person && (
            <button
              className="btn btn-danger-quiet"
              onClick={async () => {
                if (!confirm(`Remove ${person.name}? Their gifts stay on the list as "Not assigned".`)) return;
                if (await act(() => api.del(`/recipients/${person.id}`))) onClose();
              }}
            >
              Remove
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={!name.trim()}>
            {person ? "Save" : "Add person"}
          </button>
        </>
      }
    >
      <form className="form-grid" onSubmit={save}>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required placeholder="Grandma Rose" />
        </Field>
        <Field label="Budget" hint="Optional. Shows how much is left to spend.">
          <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" placeholder="$0.00" />
        </Field>
        <Field label="Notes">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Sizes, likes, wish list link…" />
        </Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
