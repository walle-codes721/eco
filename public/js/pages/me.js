import { h, icon, api, me, toast } from "/js/eco.js";
import { sampleCard } from "/js/sample.js";

const { user, signin } = await me();
const bar = h("header.bar", {}, h("div.inner", {}, h("a.brand", { href: "/" }, "Eco"), h("span.title.muted", {}, "My talks and shops"), h("span.spacer"),
  user ? h("a.btn.ghost.sm", { href: "/auth/logout" }, "Sign out") : null));
const main = h("main.wrap", { style: { maxWidth: "900px" } });
document.body.replaceChildren(bar, main);

if (!user) {
  main.append(h("section.narrow.center", { style: { paddingTop: "18vh" } },
    h("h1", { style: { fontSize: "32px", marginBottom: "8px" } }, "Sign in to keep your talks"),
    h("p.muted", {}, "Speakers and shop owners sign in to save their talks and counters and find them again. Listeners and customers never need an account."),
    h("p", { style: { marginTop: "24px" } }, signin ? h("a.btn.primary.big", { href: "/auth/google?next=/me" }, "Sign in with Google") : h("span.muted", {}, "Sign-in isn't set up on this server yet."))));
} else {
  const date = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const row = (r) => {
    const id = `${r.kind}/${user.handle}/${r.slug}`;
    const status = h("div.tiny.muted");
    const links = r.kind === "stage"
      ? [h("a.btn.primary.sm", { href: `/${id}/speak` }, icon("stage"), "Present"), h("button.btn.sm", { type: "button", onclick: (e) => duplicate(id, e.currentTarget) }, icon("copy"), "Duplicate"),
        h("a.btn.sm", { href: `/${id}/card` }, "Card"), h("a.btn.sm", { href: `/${id}` }, "Audience view"), h("button.btn.sm.ghost", { type: "button", onclick: () => remove(id, r.title, card) }, "Delete")]
      : [h("a.btn.primary.sm", { href: `/${id}/owner` }, icon("store"), "Open counter"), h("a.btn.sm", { href: `/${id}/card` }, "Weekly card"), h("a.btn.sm", { href: `/${id}/sticker` }, icon("print"), "Sticker")];
    const card = h("div.card", { style: { padding: "18px 20px" } },
      h("div.row", { style: { flexWrap: "wrap", gap: "12px" } },
        h("div", { style: { flex: "1 1 240px", minWidth: 0 } }, h("div", { style: { fontWeight: 600 } }, r.title), h("div.tiny.muted.mono.truncate", {}, `/${id} · ${date(r.created)}`), status),
        h("div.row", { style: { flexWrap: "wrap", gap: "8px" } }, ...links)));
    if (r.kind === "stage") api(`/api/rooms/${id}/meta`).then((m) => (status.textContent = presentationStatus(m))).catch(() => {});
    return card;
  };
  /** "Not started · Voices 312/744": where the talk is, and how far its HACKATHON prep has got. */
  const presentationStatus = (m) => {
    const p = m.prep;
    const prep = !p?.lines ? "" : p.translated < p.lines ? `Translating ${p.translated}/${p.lines}` : p.done < p.total ? `Voices ${p.done}/${p.total}` : `Ready · ${p.lines} lines`;
    return [{ lobby: "Not started", live: "Live", ended: "Ended" }[m.status], prep, p?.failed ? `${p.failed} failed` : ""].filter(Boolean).join(" · ");
  };
  /** Same slides, context, script, translations and voices, from the start, at a new link. No new prep. */
  const duplicate = async (id, btn) => {
    btn.disabled = true;
    try {
      const { id: to } = await api(`/api/rooms/${id}/duplicate`, { method: "POST" });
      location.href = `/${to}/speak`;
    } catch (err) {
      toast(err.message || "Couldn't duplicate");
      btn.disabled = false;
    }
  };
  const remove = async (id, title, card) => {
    if (!confirm(`Delete "${title}"? Its slides, transcript and recordings are deleted. Duplicates keep their voices.`)) return;
    try {
      await api(`/api/rooms/${id}/delete`, { method: "POST" });
      card.remove();
      toast("Deleted");
    } catch (err) {
      toast(err.message || "Couldn't delete");
    }
  };
  const list = (kind, head, empty, newHref, newLabel) => {
    const rooms = user.rooms.filter((r) => r.kind === kind);
    return h("section.form-section", {},
      h("header", {}, h("h2", {}, head), h("p", {}, h("a.btn.sm", { href: newHref }, icon("plus"), newLabel))),
      h("div.stack", {}, rooms.length ? rooms.map(row) : h("p.muted", {}, empty)));
  };

  const nameIn = h("input", { type: "text", value: user.handle, maxlength: 40, spellcheck: "false" });
  const nameForm = h("form.row", { style: { gap: "8px", flexWrap: "wrap" } }, h("span.mono.muted.small", {}, `${location.host}/stage/`), nameIn, h("button.btn.sm", { type: "submit" }, "Save"));
  nameForm.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/me", { method: "POST", body: { name: nameIn.value.trim() } });
      toast("Name saved");
    } catch (err) {
      toast(err.message);
    }
  };

  // HACKATHON mode, on by default: talks with a script are translated and voiced before the talk, then played as you read.
  const hackBox = h("input", { type: "checkbox", checked: user.hackathon !== false });
  hackBox.onchange = async () => {
    hackBox.disabled = true;
    try {
      await api("/api/me", { method: "POST", body: { hackathon: hackBox.checked } });
      toast(hackBox.checked ? "HACKATHON mode on" : "HACKATHON mode off");
    } catch {
      hackBox.checked = !hackBox.checked;
      toast("Couldn't save HACKATHON mode");
    } finally {
      hackBox.disabled = false;
    }
  };

  main.append(
    h("div.page-head", {}, h("p.eyebrow", {}, user.email), h("h1", {}, user.name || user.handle)),
    h("section.form-section", {}, h("header", {}, h("h2", {}, "HACKATHON"), h("p", {}, "For talks with a teleprompter script.")),
      h("label.check", {}, hackBox, h("span.small", {}, "When you create a talk, Eco translates every line of your script and records it in each voice ahead of time. During the talk it listens for the line you're starting and plays it to each listener, in their language and voice, about a second behind you. Anything off the script isn't translated."))),
    user.rooms.length ? h("p.small.muted", {}, "Your links start with ", h("span.mono", {}, `/${"stage"}/${user.handle}/`), ".")
      : h("section.form-section", {}, h("header", {}, h("h2", {}, "Your name"), h("p", {}, "It goes in every link you share. You can change it until you create your first talk or shop.")), nameForm),
    h("section.form-section", {}, h("header", {}, h("h2", {}, "Your saved voice"), h("p", {}, "Record it once. Any talk can use it: pick \"Your saved voice\" when you create the talk.")),
      sampleCard({ url: "/api/me/voice", playUrl: "/api/me/voice", sampleText: user.sampleText, has: user.voice, title: "Saved voice", intro: "Read this aloud in a quiet room:" })),
    list("stage", "Presentations", "No presentations yet.", "/stage/new", "New presentation"),
    list("counter", "Shops", "No shops yet.", "/counter/new", "New counter"),
  );
}
