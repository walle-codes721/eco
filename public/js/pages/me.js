import { h, icon, api, me, toast } from "/js/eco.js";

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
    const links = r.kind === "stage"
      ? [h("a.btn.primary.sm", { href: `/${id}/speak` }, icon("stage"), "Present"), h("a.btn.sm", { href: `/${id}/card` }, "Card"), h("a.btn.sm", { href: `/${id}` }, "Audience view")]
      : [h("a.btn.primary.sm", { href: `/${id}/owner` }, icon("store"), "Open counter"), h("a.btn.sm", { href: `/${id}/card` }, "Weekly card"), h("a.btn.sm", { href: `/${id}/sticker` }, icon("print"), "Sticker")];
    return h("div.card", { style: { padding: "18px 20px" } },
      h("div.row", { style: { flexWrap: "wrap", gap: "12px" } },
        h("div", { style: { flex: "1 1 240px", minWidth: 0 } }, h("div", { style: { fontWeight: 600 } }, r.title), h("div.tiny.muted.mono.truncate", {}, `/${id} · ${date(r.created)}`)),
        h("div.row", { style: { flexWrap: "wrap", gap: "8px" } }, ...links)));
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

  main.append(
    h("div.page-head", {}, h("p.eyebrow", {}, user.email), h("h1", {}, user.name || user.handle)),
    user.rooms.length ? h("p.small.muted", {}, "Your links start with ", h("span.mono", {}, `/${"stage"}/${user.handle}/`), ".")
      : h("section.form-section", {}, h("header", {}, h("h2", {}, "Your name"), h("p", {}, "It goes in every link you share. You can change it until you create your first talk or shop.")), nameForm),
    list("stage", "Talks", "No talks yet.", "/stage/new", "New talk"),
    list("counter", "Shops", "No shops yet.", "/counter/new", "New counter"),
  );
}
