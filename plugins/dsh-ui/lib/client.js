/**
 * Perseus settings card, browser half.
 *
 * The `dsh-plugin-perseus` host half declares `enabled`, `tools`, `provider`,
 * `model` and `reasoningEffort` as `.volatile()` Config fields, so `dsh-settings`
 * serves the `perseus` entry through `remote.settings` and
 * `dsh-client-ui-settings` exposes it as the shared form
 * `ctx.configForms.get("perseus")`. This card edits that form and offers the
 * entry-level enable/disable switch through `remote.pluginManager`.
 *
 * Hand-written bundle: `@deepseek-ai/dsh-client-modules` resolves a package's
 * `exports["./client"]` straight from `package.json` and never inspects bundle
 * contents, so no build step is involved. `react` is a platform seed word of the
 * client module table and nothing else is required, so the package declares no
 * `dsh.client.external` entries.
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-perseus-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    //#region identity
    /** Settings namespace: the Host loader entry id of the `perseus` patch row. */
    const PERSEUS_NS = "perseus";
    /** Loader entry identity `remote.pluginManager` addresses (not the namespace). */
    const PERSEUS_ENTRY_ID = "include:perseus";
    /** Dictionary namespace owned by this bundle. */
    const NS = "settings.perseus";
    /** Reasoning efforts the Speculator route accepts; the empty value inherits. */
    const EFFORTS = ["off", "low", "high", "max"];
    //#endregion
    //#region locales
    /** English copy. */
    const en = {
      title: "Perseus",
      description: "Asynchronous speculative acquisition for this session.",
      enabled: "Enable Perseus",
      enabledHint: "When off, requests run without speculative acquisition while the plugin stays loaded.",
      on: "Enabled",
      off: "Disabled",
      tools: "Speculator tool allowlist",
      toolsHint: "Comma-separated tool names. Leave empty to allow every tool the Actor can execute.",
      toolsPlaceholder: "read, grep, glob",
      model: "Speculator model",
      modelHint: "Overrides the model for speculative calls only; the Actor route is unchanged.",
      provider: "Speculator provider",
      providerHint: "Overrides the provider for speculative calls only.",
      effort: "Reasoning effort",
      effortHint: "Speculator-only override; the adapter rejects unsupported values.",
      inherit: "Use the session default",
      apply: "Apply",
      applying: "Applying…",
      discard: "Discard",
      dirty: "Unsaved changes",
      unset: "default",
      loading: "Loading the Perseus configuration…",
      unavailable: "This deployment does not serve Perseus settings.",
      readOnly: "This deployment stores settings read-only.",
      saveFailed: "The deployment did not accept these values; they were left for you to correct.",
      row: "Plugin row",
      rowHint: "Switching the row off unloads the plugin, which also removes this card; re-enable it from the plugin list.",
      rowDisable: "Disable the Perseus plugin row",
      rowDisabling: "Disabling…",
      rowDisabled: "The row was disabled; the plugin is unloading.",
      rowOverridden: "A higher-priority layer still enables the row, so the stored value has no effect yet.",
      rowRestart: "Saved; the running process needs a restart before the row changes.",
      rowCancelled: "The request was cancelled.",
      rowFailed: "The deployment refused the change."
    };
    /** Simplified Chinese copy. */
    const zh = {
      title: "Perseus",
      description: "为本会话启用异步投机采集。",
      enabled: "启用 Perseus",
      enabledHint: "关闭后请求不再进行投机采集，插件仍保持加载。",
      on: "已启用",
      off: "已关闭",
      tools: "Speculator 工具白名单",
      toolsHint: "以逗号分隔的工具名。留空表示允许 Actor 可执行的全部工具。",
      toolsPlaceholder: "read, grep, glob",
      model: "Speculator 模型",
      modelHint: "仅覆盖投机调用使用的模型；Actor 的路由保持不变。",
      provider: "Speculator 提供方",
      providerHint: "仅覆盖投机调用使用的提供方。",
      effort: "推理强度",
      effortHint: "仅对 Speculator 生效；适配器会拒绝不支持的值。",
      inherit: "使用会话默认值",
      apply: "应用",
      applying: "应用中…",
      discard: "放弃修改",
      dirty: "有未保存的修改",
      unset: "默认",
      loading: "正在读取 Perseus 配置…",
      unavailable: "本部署未提供 Perseus 设置。",
      readOnly: "本部署的设置为只读。",
      saveFailed: "本部署没有接受这些值，已保留供你修改。",
      row: "插件行",
      rowHint: "关闭该行会卸载插件，本卡片也会随之消失；可在插件列表中重新启用。",
      rowDisable: "关闭 Perseus 插件行",
      rowDisabling: "正在关闭…",
      rowDisabled: "已关闭该行，插件正在卸载。",
      rowOverridden: "更高优先级的层仍启用该行，因此保存的值暂时不生效。",
      rowRestart: "已保存；需要重启进程后该行才会变化。",
      rowCancelled: "请求已取消。",
      rowFailed: "本部署拒绝了该变更。"
    };
    //#endregion
    //#region form projection
    /** Split the allowlist's text form on commas and whitespace. */
    function parseTools(text) {
      return text.split(/[\s,]+/u).filter(Boolean);
    }
    /** Render an allowlist value as the text the field edits. */
    function formatTools(value) {
      return Array.isArray(value) ? value.filter((entry) => typeof entry === "string").join(", ") : "";
    }
    /** Project a form snapshot's namespace section onto the editable fields. */
    function acceptedOf(value) {
      const section = value !== null && typeof value === "object" ? value : {};
      return {
        enabled: section.enabled !== false,
        tools: formatTools(section.tools),
        model: typeof section.model === "string" ? section.model : "",
        provider: typeof section.provider === "string" ? section.provider : "",
        reasoningEffort: typeof section.reasoningEffort === "string" ? section.reasoningEffort : ""
      };
    }
    /** Whether the draft still differs from the accepted section. */
    function isDirty(draft, accepted) {
      return draft.enabled !== accepted.enabled || draft.tools !== accepted.tools || draft.model !== accepted.model
        || draft.provider !== accepted.provider || draft.reasoningEffort !== accepted.reasoningEffort;
    }
    /**
     * Translate one staged draft into the ordered path ops `mutate` applies.
     * A cleared optional field is unset rather than set to "", so "absent" stays
     * distinct from an explicitly empty route override or allowlist.
     */
    function opsFor(draft, accepted) {
      const ops = [];
      if (draft.enabled !== accepted.enabled) ops.push({ op: "set", path: ["enabled"], value: draft.enabled });
      if (draft.tools !== accepted.tools) {
        const tools = parseTools(draft.tools);
        ops.push(tools.length === 0 ? { op: "unset", path: ["tools"] } : { op: "set", path: ["tools"], value: tools });
      }
      for (const field of ["model", "provider", "reasoningEffort"]) {
        const next = draft[field].trim();
        if (next === accepted[field]) continue;
        ops.push(next === "" ? { op: "unset", path: [field] } : { op: "set", path: [field], value: next });
      }
      return ops;
    }
    /** Read a human message out of an unknown error payload. */
    function describeError(value) {
      if (value === undefined || value === null) return undefined;
      if (typeof value === "string") return value;
      if (typeof value !== "object") return String(value);
      if (typeof value.message === "string") return value.message;
      if (typeof value.code === "string") return value.code;
      try {
        return JSON.stringify(value);
      } catch (_unserializable) {
        return undefined;
      }
    }
    /**
     * Unwrap one `remote.pluginManager` answer. The Remote wire wraps the
     * management result as `{ ok, value }`, while a direct call answers the
     * `{ stage, target, enabled, changed, application, error? }` record itself.
     */
    function managementOutcome(answer) {
      const envelope = answer !== null && typeof answer === "object" && answer.value !== undefined ? answer.value : answer;
      const failed = answer !== null && typeof answer === "object" && answer.ok === false;
      const application = envelope !== null && typeof envelope === "object" ? envelope.application : undefined;
      const error = envelope !== null && typeof envelope === "object" ? envelope.error : undefined;
      return { failed, application, error };
    }
    //#endregion
    //#region styles
    const styles = {
      form: { display: "grid", gap: "14px", maxWidth: "560px" },
      intro: { margin: "0", opacity: 0.75, fontSize: "12px", lineHeight: 1.5 },
      notice: { margin: "0", fontSize: "12px", opacity: 0.75 },
      field: { display: "grid", gap: "4px" },
      label: { fontSize: "12px", fontWeight: 600 },
      hint: { fontSize: "11px", opacity: 0.6, lineHeight: 1.4 },
      row: { display: "flex", alignItems: "center", gap: "8px" },
      control: {
        boxSizing: "border-box", width: "100%", padding: "6px 8px", fontSize: "12px", color: "inherit",
        background: "transparent", border: "1px solid rgba(127,127,127,0.4)", borderRadius: "6px"
      },
      actions: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
      button: {
        padding: "5px 12px", fontSize: "12px", color: "inherit", cursor: "pointer",
        background: "transparent", border: "1px solid rgba(127,127,127,0.4)", borderRadius: "6px"
      },
      separator: { borderTop: "1px solid rgba(127,127,127,0.25)", margin: "2px 0" },
      dirty: { fontSize: "11px", opacity: 0.7 },
      error: { fontSize: "11px", color: "#e5534b", lineHeight: 1.4 }
    };
    //#endregion
    //#region components
    /** One labelled field row; the hint carries the behavioural contract. */
    function Field(props) {
      const children = [react.createElement("label", { key: "label", style: styles.label, htmlFor: props.id }, props.label),
        react.createElement("div", { key: "control", style: props.inline === true ? styles.row : undefined }, props.children)];
      if (props.hint !== undefined) children.push(react.createElement("span", { key: "hint", style: styles.hint }, props.hint));
      return react.createElement("div", { style: styles.field }, children);
    }
    /**
     * The staged form over the shared controller: a local draft, one atomic
     * mutation per apply, and the revision fence taken from the snapshot the
     * draft was read at. A landed write re-derives the snapshot, which adopts
     * the accepted section and clears the dirty state on its own.
     */
    function PerseusForm(props) {
      const read = props.t;
      const form = props.perseusForm;
      const snapshot = props.snapshot;
      const accepted = react.useMemo(() => acceptedOf(snapshot.value), [snapshot.value, snapshot.revision]);
      const [draft, setDraft] = react.useState(accepted);
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(undefined);
      react.useEffect(() => {
        setDraft(accepted);
        setError(undefined);
      }, [accepted]);
      if (snapshot.status === "unavailable") return react.createElement("p", { style: styles.notice }, read("unavailable"));
      if (snapshot.status === "loading") return react.createElement("p", { style: styles.notice }, read("loading"));
      const locked = snapshot.writable !== true;
      const disabled = locked || busy;
      const dirty = isDirty(draft, accepted);
      const edit = (patch) => setDraft((current) => ({ ...current, ...patch }));
      const applyDraft = async () => {
        const ops = opsFor(draft, accepted);
        if (disabled || ops.length === 0) return;
        setBusy(true);
        setError(undefined);
        try {
          const saved = await form.mutate(ops, snapshot.revision);
          if (!saved) setError(read("saveFailed"));
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };
      const children = [
        react.createElement("p", { key: "intro", style: styles.intro }, read("description")),
        locked ? react.createElement("p", { key: "readonly", style: styles.notice }, read("readOnly")) : undefined,
        react.createElement(Field, { key: "enabled", id: "perseus-enabled", label: read("enabled"), hint: read("enabledHint"), inline: true }, [
          react.createElement("input", {
            key: "input", id: "perseus-enabled", type: "checkbox", checked: draft.enabled, disabled,
            onChange: (event) => edit({ enabled: event.target.checked })
          }),
          react.createElement("span", { key: "state", style: styles.hint }, draft.enabled ? read("on") : read("off"))
        ]),
        react.createElement(Field, { key: "tools", id: "perseus-tools", label: read("tools"), hint: read("toolsHint") },
          react.createElement("input", {
            id: "perseus-tools", type: "text", style: styles.control, value: draft.tools, disabled,
            placeholder: read("toolsPlaceholder"), spellCheck: false,
            onChange: (event) => edit({ tools: event.target.value })
          })),
        react.createElement(Field, { key: "model", id: "perseus-model", label: read("model"), hint: read("modelHint") },
          react.createElement("input", {
            id: "perseus-model", type: "text", style: styles.control, value: draft.model, disabled,
            placeholder: read("unset"), spellCheck: false,
            onChange: (event) => edit({ model: event.target.value })
          })),
        react.createElement(Field, { key: "effort", id: "perseus-effort", label: read("effort"), hint: read("effortHint") },
          react.createElement("select", {
            id: "perseus-effort", style: styles.control, value: draft.reasoningEffort, disabled,
            onChange: (event) => edit({ reasoningEffort: event.target.value })
          }, [""].concat(EFFORTS).map((effort) => react.createElement("option", { key: effort, value: effort },
            effort === "" ? read("inherit") : effort)))),
        react.createElement(Field, { key: "provider", id: "perseus-provider", label: read("provider"), hint: read("providerHint") },
          react.createElement("input", {
            id: "perseus-provider", type: "text", style: styles.control, value: draft.provider, disabled,
            placeholder: read("unset"), spellCheck: false,
            onChange: (event) => edit({ provider: event.target.value })
          })),
        react.createElement("div", { key: "actions", style: styles.actions }, [
          react.createElement("button", {
            key: "apply", type: "button", style: styles.button, disabled: disabled || !dirty,
            onClick: () => {
              void applyDraft();
            }
          }, busy ? read("applying") : read("apply")),
          react.createElement("button", {
            key: "discard", type: "button", style: styles.button, disabled: disabled || !dirty,
            onClick: () => {
              setDraft(accepted);
              setError(undefined);
            }
          }, read("discard")),
          dirty ? react.createElement("span", { key: "dirty", style: styles.dirty }, read("dirty")) : undefined,
          error === undefined ? undefined : react.createElement("span", { key: "error", style: styles.error }, error)
        ])
      ];
      if (props.perseusRow !== undefined) {
        children.push(react.createElement("div", { key: "separator", style: styles.separator }));
        children.push(react.createElement(PerseusRow, { key: "row", t: read, row: props.perseusRow }));
      }
      return react.createElement("section", { style: styles.form, "data-plugin-config-perseus": true }, children);
    }
    /**
     * The entry-level switch: `setPluginEnabled` persists `disabled` on the
     * profile patch row and applies it live, and it answers a management record
     * whose `application` says whether the change took effect.
     */
    function PerseusRow(props) {
      const read = props.t;
      const row = props.row;
      const [busy, setBusy] = react.useState(false);
      const [outcome, setOutcome] = react.useState(undefined);
      const disable = async () => {
        setBusy(true);
        setOutcome(undefined);
        try {
          const { failed, application, error } = managementOutcome(await row.setEnabled(false));
          if (failed) {
            setOutcome({ kind: "error", text: describeError(error) ?? read("rowFailed") });
            return;
          }
          if (application === "failed") {
            setOutcome({ kind: "error", text: describeError(error) ?? read("rowFailed") });
            return;
          }
          if (application === "restart-required") {
            setOutcome({ kind: "notice", text: read("rowRestart") });
            return;
          }
          if (application === "overridden") {
            setOutcome({ kind: "notice", text: read("rowOverridden") });
            return;
          }
          if (application === "cancelled") {
            setOutcome({ kind: "notice", text: read("rowCancelled") });
            return;
          }
          setOutcome({ kind: "notice", text: read("rowDisabled") });
        } catch (failure) {
          setOutcome({ kind: "error", text: failure instanceof Error ? failure.message : String(failure) });
        } finally {
          setBusy(false);
        }
      };
      const children = [
        react.createElement("span", { key: "label", style: styles.label }, read("row")),
        react.createElement("button", {
          key: "toggle", type: "button", style: styles.button, disabled: busy,
          onClick: () => {
            void disable();
          }
        }, busy ? read("rowDisabling") : read("rowDisable"))
      ];
      if (outcome !== undefined) {
        children.push(react.createElement("span", {
          key: "outcome", style: outcome.kind === "error" ? styles.error : styles.hint
        }, outcome.text));
      }
      return react.createElement("div", { style: styles.field }, [
        react.createElement("div", { key: "row", style: styles.actions }, children),
        react.createElement("span", { key: "hint", style: styles.hint }, read("rowHint"))
      ]);
    }
    /**
     * Render the Perseus card: its one-liner in the list, its settings form on
     * the page. The snapshot comes from the shared `configForms` controller
     * through the `perseusCard` hook the registration injects.
     */
    function PerseusCard(props) {
      const snapshot = props.usePerseusCard((value) => value);
      if (props.view === "summary") return props.t("description");
      return react.createElement(PerseusForm, {
        t: props.t, snapshot, perseusForm: props.perseusForm, perseusRow: props.perseusRow
      });
    }
    //#endregion
    //#region plugin
    /** Required services (cordis fiber inject). */
    const inject = ["slots", "locale", "configForms", "remote"];
    /**
     * Mount the Perseus card while the Host serves its namespace, so a
     * deployment that never composed the plugin shows no trace of it.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-settings-perseus: dictionaries");
      // The form is owned by the settings provider, which disposes every shared
      // form on its own teardown; this bundle must not dispose it out from under
      // another consumer.
      const form = ctx.configForms.get(PERSEUS_NS);
      const pluginManager = ctx.remote === undefined ? undefined : ctx.remote.pluginManager;
      const canToggleRow = pluginManager !== undefined && typeof pluginManager.setPluginEnabled === "function";
      // A stable inject face: `hooks.perseusCard` becomes the `usePerseusCard`
      // prop, and the rest rides the same business props share.
      const face = {
        hooks: { perseusCard: form },
        perseusForm: form,
        ...canToggleRow ? {
          perseusRow: { entryId: PERSEUS_ENTRY_ID, setEnabled: (enabled) => pluginManager.setPluginEnabled(PERSEUS_ENTRY_ID, enabled) }
        } : {}
      };
      ctx.effect(() => ctx.configForms.whileServed([PERSEUS_NS], () => ctx.slots.inject("plugins.item", () => ctx.slots.register({
        name: "plugins.item",
        id: "perseus",
        order: 50,
        label: () => t("title"),
        locale: NS,
        inject: () => face
      }, PerseusCard))), "ui-settings-perseus: page");
    }
    //#endregion
    exports.apply = apply;
    exports.inject = inject;
    exports.NS = NS;
    return module.exports;
  }
});
