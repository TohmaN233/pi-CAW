# Create and manage Workflows

## Create from a brief or Skill

1. For a brief, call `caw build_workflow`. Use `template_kind: workflow` for a task process or `role` for one reusable helper behavior.
2. For a Skill, call `caw skill_inventory`, select one entry, then `caw import_skill`. Use `discovery: folders` with an absolute `folder` for a custom location, or `discovery: host` with a workspace for Host discovery. Keep the same discovery selection when importing.
3. Check the Draft's inputs, resources, dependencies and access. Use portable executable names; the Host registers local program locations. Obtain authorization before installing missing dependencies.
4. Select explicit planner and reviewer bindings, then call `caw start_authoring` for Workflow compilation and review. Use `caw advance_authoring` to inspect actionable progress.
5. At `review_required`, have the user accept the exact proposal in the Workbench. Role briefs produce a Role Draft for direct review.

## Edit a definition

- Read `caw read`, save graph changes with `caw save`, and edit resources with `caw write_resource`, using the returned revision for CAS.
- Preserve declared input bindings, permissions and required human gates. Converted Workflows use their own assets rather than the original Skill at runtime.
- Authoring Agents define semantic activities, data and source requirements. Use Host-provided `contract_ref` selections for pinned schemas; the Host compiles graph IDs, schemas and bindings.
- For compiler diagnostics, correct the named fields in the current turn. Semantic repair patches change only the indicated stable keys. Use Workbench `recheck_authoring` to compile and review a retained proposal after a Host fix.
- Publish the reviewed Draft through the Workbench. Publication makes it Ready without starting a Run.

## Share or install

Use `caw export_workflow_package` for one installable revision. Install a local file with `caw install_workflow_package` and `package_path`, or use its `url` option for HTTPS. Keep a full Pack diagnostic export separate from an installable package.

Use [repair loops](loops.md) for bounded review/repair and [parallel writes](parallel.md) for worktree integration.
