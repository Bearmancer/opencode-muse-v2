import { Plugin } from "@opencode/plugin/tui";
import type {} from "@opentui/solid";
import { createSignal } from "solid-js";
import { readMuseUsage, renderMeterLines, type MuseUsage } from "./usage.js";

export default Plugin.define({
  id: "opencode-muse.usage",
  setup(context) {
    const [usage, setUsage] = createSignal<MuseUsage>({ window: null, weekly: null });
    let disposed = false;

    const refresh = () => {
      void readMuseUsage()
        .then((next) => {
          if (!disposed) setUsage(next);
        })
        .catch(() => {});
    };

    refresh();
    const timer = setInterval(refresh, 60_000);

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: () => {
        const fg = context.theme.text.base;
        return (
          <box flexDirection="column">
            <text fg={fg}>Muse usage</text>
            {renderMeterLines(usage()).map((line) => (
              <text fg={fg}>{line.text}</text>
            ))}
          </box>
        );
      },
    });

    return () => {
      disposed = true;
      clearInterval(timer);
      unregister();
    };
  },
});
