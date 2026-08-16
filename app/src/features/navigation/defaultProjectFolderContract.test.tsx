import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CreateProjectDialog } from "./ProjectSidebar";

describe("default project folder confirmation", () => {
  it("prefills the selected directory but submits it only after an explicit named-project confirmation", async () => {
    const onCreate = vi.fn();
    render(<CreateProjectDialog
      initialFolderPath="  D:\\work\\prime  "
      onCreate={onCreate}
      onCancel={() => undefined}
    />);

    const folder = screen.getByRole("textbox", { name: "Folder path" });
    const create = screen.getByRole("button", { name: "Create project" });
    expect(folder).toHaveValue("  D:\\work\\prime  ");
    expect(create).toBeDisabled();
    expect(onCreate).not.toHaveBeenCalled();

    await userEvent.type(screen.getByRole("textbox", { name: "Project name" }), "  Confirmed project  ");
    await userEvent.click(create);

    expect(onCreate).toHaveBeenCalledOnce();
    expect(onCreate).toHaveBeenCalledWith("Confirmed project", "D:\\work\\prime");
  });
});
