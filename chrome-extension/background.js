// Orka Tab Groups - Auto-group tabs by project
// Colors available in Chrome's Tab Groups API
const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'];

// Track project -> color assignment for consistency within a session
const projectColorMap = new Map();
let colorIndex = 0;

// Debounce map to avoid rapid re-grouping
const pendingTabs = new Map();
const DEBOUNCE_MS = 100;

// Orka route patterns
const PROJECT_ROUTE_RE = /\/projects\/([A-Za-z0-9+/=_-]+)\//;
const ORKA_GENERAL_RE = /\/(dashboard|agents)(\?|$|#)/;
const ORKA_HOME_RE = /\/$/;

function decodeProjectPath(encoded) {
  // Undo URL-safe base64: replace - with +, _ with /
  let padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding
  while (padded.length % 4) padded += '=';
  try {
    return atob(padded);
  } catch {
    return null;
  }
}

function getProjectName(fullPath) {
  if (!fullPath) return null;
  const segments = fullPath.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : null;
}

function getColorForProject(projectName) {
  if (projectColorMap.has(projectName)) {
    return projectColorMap.get(projectName);
  }
  const color = GROUP_COLORS[colorIndex % GROUP_COLORS.length];
  colorIndex++;
  projectColorMap.set(projectName, color);
  return color;
}

function isOrkaUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    // Match localhost or 127.0.0.1 on any port, or any host with Orka-like paths
    if (host === 'localhost' || host === '127.0.0.1') return true;
    // For remote access, check if path looks like Orka
    return PROJECT_ROUTE_RE.test(u.pathname) ||
           ORKA_GENERAL_RE.test(u.pathname) ||
           u.pathname === '/';
  } catch {
    return false;
  }
}

function classifyTab(url) {
  try {
    const u = new URL(url);
    const pathname = u.pathname;

    // Check for project-specific routes
    const projectMatch = pathname.match(PROJECT_ROUTE_RE);
    if (projectMatch) {
      const encoded = projectMatch[1];
      const fullPath = decodeProjectPath(encoded);
      const projectName = getProjectName(fullPath);
      if (projectName) {
        return { type: 'project', name: projectName };
      }
    }

    // Check for general Orka routes
    if (ORKA_GENERAL_RE.test(pathname) || pathname === '/') {
      return { type: 'general' };
    }

    return null;
  } catch {
    return null;
  }
}

async function findGroupByTitle(title) {
  const groups = await chrome.tabGroups.query({ title });
  return groups.length > 0 ? groups[0] : null;
}

async function groupTab(tabId, tabUrl) {
  if (!tabUrl || !isOrkaUrl(tabUrl)) return;

  const classification = classifyTab(tabUrl);
  if (!classification) return;

  const groupTitle = classification.type === 'project'
    ? classification.name
    : 'Orka';

  const color = classification.type === 'project'
    ? getColorForProject(classification.name)
    : 'orange';

  try {
    // Check if tab still exists
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;

    // Find existing group
    const existingGroup = await findGroupByTitle(groupTitle);

    if (existingGroup) {
      // Add tab to existing group
      await chrome.tabs.group({ tabIds: tabId, groupId: existingGroup.id });
    } else {
      // Create new group with this tab
      const groupId = await chrome.tabs.group({ tabIds: tabId });
      await chrome.tabGroups.update(groupId, { title: groupTitle, color });
    }
  } catch (err) {
    // Tab may have been closed or moved - ignore
    console.debug('Orka Tab Groups: could not group tab', tabId, err.message);
  }
}

function scheduleGrouping(tabId, url) {
  // Clear any pending grouping for this tab
  if (pendingTabs.has(tabId)) {
    clearTimeout(pendingTabs.get(tabId));
  }

  pendingTabs.set(tabId, setTimeout(() => {
    pendingTabs.delete(tabId);
    groupTab(tabId, url);
  }, DEBOUNCE_MS));
}

// Listen for tab URL changes (navigations, new tabs)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only act when URL changes (not on every title change, etc.)
  if (changeInfo.url) {
    scheduleGrouping(tabId, changeInfo.url);
  }
  // Also group on complete if not yet grouped (handles initial load)
  if (changeInfo.status === 'complete' && tab.url && tab.groupId === -1) {
    scheduleGrouping(tabId, tab.url);
  }
});

// Group existing tabs on extension install/startup
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url && tab.id !== undefined) {
      scheduleGrouping(tab.id, tab.url);
    }
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url && tab.id !== undefined) {
      scheduleGrouping(tab.id, tab.url);
    }
  }
});
