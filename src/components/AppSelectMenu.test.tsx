import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSelectMenu, type AppSelectOption } from "./AppSelectMenu";

const options = (count: number): AppSelectOption[] =>
  Array.from({ length: count }, (_, index) => ({
    value: `vendor/model-${index}`,
    label: `Vendor Model ${index}`,
    detail: `vendor/model-${index}`,
  }));

function open(name = "Default model") {
  fireEvent.click(screen.getByRole("button", { name }));
}

function search(value: string, ariaLabel = "Default model") {
  fireEvent.change(screen.getByRole("textbox", { name: `Search ${ariaLabel}` }), { target: { value } });
}

describe("AppSelectMenu", () => {
  it("shows disabled catalog entries without allowing selection", () => {
    const onChange = vi.fn();
    render(<AppSelectMenu value="" ariaLabel="Model" options={[{ value: "next", label: "Next model", disabled: true }]} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const option = screen.getByRole("menuitemradio", { name: "Next model" });
    expect(option).toBeDisabled();
    fireEvent.click(option);
    expect(onChange).not.toHaveBeenCalled();
  });
  // The Settings and sub-agent pickers read from the same live catalogs as the
  // composer, so a capped result list would hide models there instead.
  it("shows every match for a search, past the browse limit", () => {
    render(<AppSelectMenu value="" options={options(250)} ariaLabel="Default model" searchable onChange={vi.fn()} />);
    open();
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(80);
    search("vendor");
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(250);
  });

  it("finds an option far past the browse limit", () => {
    render(<AppSelectMenu value="" options={options(300)} ariaLabel="Default model" searchable onChange={vi.fn()} />);
    open();
    search("model-299");
    expect(screen.getByRole("menuitemradio", { name: /Vendor Model 299/ })).toBeInTheDocument();
  });

  it("reveals the remainder of a long list on request", () => {
    render(<AppSelectMenu value="" options={options(300)} ariaLabel="Default model" searchable onChange={vi.fn()} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: /Show all 300 options \(220 more\)/ }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(300);
  });

  it("matches every token across label, detail, value, and keywords", () => {
    render(
      <AppSelectMenu
        value=""
        options={[
          { value: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", detail: "anthropic/claude-sonnet-5", keywords: "efficient routine" },
          { value: "openai/gpt-5.6", label: "GPT-5.6", detail: "openai/gpt-5.6" },
        ]}
        ariaLabel="Default model"
        searchable
        onChange={vi.fn()}
      />,
    );
    open();
    search("anthropic routine");
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(1);
  });

  it("puts starred options first under a Favorites heading", () => {
    render(
      <AppSelectMenu
        value=""
        options={options(4)}
        ariaLabel="Default model"
        favorites={["vendor/model-2"]}
        onToggleFavorite={vi.fn()}
        onChange={vi.fn()}
      />,
    );
    open();
    expect(screen.getAllByRole("menuitemradio")[0]).toHaveTextContent("Vendor Model 2");
    expect(screen.getByText("Favorites")).toBeInTheDocument();
    expect(screen.getByText("All models")).toBeInTheDocument();
  });

  it("stars an option without choosing it or closing the menu", () => {
    const onToggleFavorite = vi.fn();
    const onChange = vi.fn();
    render(
      <AppSelectMenu
        value=""
        options={options(3)}
        ariaLabel="Default model"
        favorites={[]}
        onToggleFavorite={onToggleFavorite}
        onChange={onChange}
      />,
    );
    open();
    fireEvent.click(screen.getByRole("button", { name: "Star Vendor Model 1" }));
    expect(onToggleFavorite).toHaveBeenCalledWith("vendor/model-1");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
  });

  it("renders no stars when the owner supplies no toggle", () => {
    render(<AppSelectMenu value="" options={options(3)} ariaLabel="Default model" onChange={vi.fn()} />);
    open();
    expect(screen.queryByRole("button", { name: /^Star / })).not.toBeInTheDocument();
  });

  describe("remote search", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("asks the owner to widen the catalog after a pause in typing", () => {
      const onSearch = vi.fn();
      render(<AppSelectMenu value="" options={options(3)} ariaLabel="Default model" searchable onSearch={onSearch} onChange={vi.fn()} />);
      open();
      search("kimi");
      expect(onSearch).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(400); });
      expect(onSearch).toHaveBeenCalledWith("kimi");
    });
  });
});
