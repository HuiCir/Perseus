export const DEFAULT_CONFIG = Object.freeze({
  speculatorModel: 'gpt-6-luna', speculatorEffort: 'high',
  tools: Object.freeze(['read', 'grep', 'glob', 'command_exec']), hookWatchMs: 100000,
});

// Transient overrides on the private inference host, never user config writes.
export const WORKER_HOST_CONFIG = Object.freeze({
  'features.hooks': false, 'features.plugins': false, 'features.apps': false,
  'features.multi_agent': false, 'features.shell_tool': false, 'features.unified_exec': false,
  'features.code_mode': false,
  'features.multi_agent_v2': false, 'features.skip_host_skill_discovery': true,
  'features.skill_search': false, 'features.skill_mcp_dependency_install': false,
  'skills.include_instructions': false, 'cloud.skills.enabled': false,
  'orchestrator.mcp.enabled': false, 'tools.update_plan.enabled': false,
  'tools.experimental_request_user_input.enabled': false,
  'features.computer_use': false, 'features.browser_use': false,
  'features.in_app_browser': false, 'features.view_image': false,
  'features.image_generation': false, 'features.sleep_tool': false,
  'features.goals': false, 'features.memories': false,
  web_search: 'disabled',
});
