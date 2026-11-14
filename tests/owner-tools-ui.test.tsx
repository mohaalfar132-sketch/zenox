// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", async () => await import("react-native-web"));
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));

import { OwnerAreaTabs, OwnerToolsPanel, type OwnerAreaId, type OwnerToolItem } from "../components/owner-areas";

declare global {
  // React asks for this flag before it will run act() outside a test renderer.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TOOLS: OwnerToolItem[] = [
  { name: "run_tests", label: "شغّل الاختبارات" },
  { name: "typecheck", label: "فحص الأنواع" },
  { name: "speed_report", label: "تقرير السرعة" },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Centre({ onRun, busy = false }: { onRun: (name: string) => void; busy?: boolean }) {
  const [area, setArea] = useState<OwnerAreaId>("management");
  return (
    <>
      <OwnerAreaTabs selected={area} onSelect={setArea} />
      {area === "tools" && (
        <OwnerToolsPanel tools={TOOLS} unlocked busy={busy} result="لم يُنفّذ شيء بعد." onRun={onRun} />
      )}
    </>
  );
}

function click(testId: string) {
  const node = container.querySelector(`[data-testid="${testId}"]`);
  if (!node) throw new Error(`missing element: ${testId}`);
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

describe("owner centre tools section", () => {
  it("opens from «أدوات سريعة» and shows the panel", () => {
    act(() => root.render(<Centre onRun={() => {}} />));
    // Before opening: the tab exists, the panel does not.
    expect(container.textContent).toContain("أدوات سريعة");
    expect(container.querySelector('[data-testid="owner-tools-panel"]')).toBeNull();

    click("owner-area-tools");

    expect(container.querySelector('[data-testid="owner-tools-panel"]')).not.toBeNull();
    expect(container.textContent).toContain("أدوات فورية");
    for (const tool of TOOLS) {
      expect(container.querySelector(`[data-testid="owner-tool-${tool.name}"]`)).not.toBeNull();
    }
  });

  it("runs the tool whose button is pressed", () => {
    const onRun = vi.fn();
    act(() => root.render(<Centre onRun={onRun} />));
    click("owner-area-tools");

    click("owner-tool-run_tests");
    expect(onRun).toHaveBeenCalledWith("run_tests");

    click("owner-tool-speed_report");
    expect(onRun).toHaveBeenLastCalledWith("speed_report");
    expect(onRun).toHaveBeenCalledTimes(2);
  });

  it("ignores presses while a tool is running", () => {
    const onRun = vi.fn();
    act(() => root.render(<Centre onRun={onRun} busy />));
    click("owner-area-tools");
    click("owner-tool-typecheck");
    expect(onRun).not.toHaveBeenCalled();
  });

  it("keeps the panel locked for a signed-out owner", () => {
    act(() =>
      root.render(<OwnerToolsPanel tools={TOOLS} unlocked={false} busy={false} result="" onRun={() => {}} />),
    );
    act(() => root.render(<OwnerToolsPanel tools={TOOLS} unlocked={false} busy={false} result="" onRun={() => {}} />));
    expect(container.textContent).toContain("الأدوات معطّلة حتى يتم الدخول إلى مساحة ZENOX");
    expect(container.querySelector('[data-testid="owner-tool-run_tests"]')).toBeNull();
  });
});
