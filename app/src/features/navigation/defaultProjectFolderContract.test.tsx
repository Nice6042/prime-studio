import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CreateProjectDialog } from "./ProjectSidebar";

const defaultFolder = String.raw`D:\work\prime`;

describe("default project folder confirmation", () => {
  it("prefills the selected directory but submits it only after an explicit named-project confirmation", async () => {
    const onCreate = vi.fn();
    const spacedFolder = `  ${defaultFolder}  `;
    render(<CreateProjectDialog
      initialFolderPath={spacedFolder}
      onCreate={onCreate}
      onCancel={() => undefined}
    />);

    const folder = screen.getByRole("textbox", { name: "Folder path" });
    const create = screen.getByRole("button", { name: "Create project" });
    expect(folder).toHaveValue(spacedFolder);
    expect(create).toBeDisabled();
    expect(onCreate).not.toHaveBeenCalled();

    await userEvent.type(screen.getByRole("textbox", { name: "Project name" }), "  Confirmed project  ");
    await userEvent.click(create);

    expect(onCreate).toHaveBeenCalledOnce();
    expect(onCreate).toHaveBeenCalledWith("Confirmed project", defaultFolder);
  });

  it("keeps a prefilled folder side-effect free when the user cancels", async () => {
    const onCreate = vi.fn();
    const onCancel = vi.fn();
    render(<CreateProjectDialog
      initialFolderPath={defaultFolder}
      onCreate={onCreate}
      onCancel={onCancel}
    />);

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("lets the user replace the configured folder before confirmation", async () => {
    const onCreate = vi.fn();
    const overrideFolder = String.raw`E:\other\project`;
    render(<CreateProjectDialog
      initialFolderPath={defaultFolder}
      onCreate={onCreate}
      onCancel={() => undefined}
    />);

    const folder = screen.getByRole("textbox", { name: "Folder path" });
    await userEvent.clear(folder);
    await userEvent.type(folder, overrideFolder);
    await userEvent.type(screen.getByRole("textbox", { name: "Project name" }), "Override project");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect(onCreate).toHaveBeenCalledWith("Override project", overrideFolder);
  });
});
