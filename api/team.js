const config = require("../roblox-team.config.json");

const ROBLOX_GROUPS_API = "https://groups.roblox.com/v1/groups";
const ROBLOX_THUMBNAILS_API =
  "https://thumbnails.roblox.com/v1/users/avatar-headshot";

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "kauri-team-sync/1.0"
    }
  });

  if (!response.ok) {
    const error = new Error(`Request failed with ${response.status}`);
    error.status = response.status;
    error.body = await response.text();
    throw error;
  }

  return response.json();
}

async function getRoleDirectory(groupId) {
  const data = await fetchJson(`${ROBLOX_GROUPS_API}/${groupId}/roles`);
  return data.roles || [];
}

async function getUsersForRole(groupId, roleId) {
  const users = [];
  let cursor = null;

  do {
    const url = new URL(
      `${ROBLOX_GROUPS_API}/${groupId}/roles/${roleId}/users`
    );
    url.searchParams.set("limit", "100");
    url.searchParams.set("sortOrder", "Asc");

    if (cursor) {
      url.searchParams.set("cursor", cursor);
    }

    const data = await fetchJson(url.toString());
    users.push(...(data.data || []));
    cursor = data.nextPageCursor || null;
  } while (cursor);

  return users;
}

async function getAvatarMap(userIds) {
  if (!userIds.length) {
    return new Map();
  }

  const url = new URL(ROBLOX_THUMBNAILS_API);
  url.searchParams.set("userIds", userIds.join(","));
  url.searchParams.set("size", "150x150");
  url.searchParams.set("format", "Png");
  url.searchParams.set("isCircular", "false");

  const data = await fetchJson(url.toString());
  const map = new Map();

  for (const entry of data.data || []) {
    map.set(entry.targetId, entry.imageUrl || "");
  }

  return map;
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  res.end(JSON.stringify(payload));
}

module.exports = async (req, res) => {
  if (req.method && req.method !== "GET") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  const { groupId, roles: configuredRoles } = config;

  try {
    const roleDirectory = await getRoleDirectory(groupId);
    const membersByUserId = new Map();
    const unresolvedRoles = [];

    for (const configuredRole of configuredRoles) {
      const matchedRole = roleDirectory.find(
        (role) => role.name === configuredRole.name
      );

      if (!matchedRole) {
        unresolvedRoles.push(configuredRole.name);
        continue;
      }

      const users = await getUsersForRole(groupId, matchedRole.id);

      for (const user of users) {
        const existing = membersByUserId.get(user.userId) || {
          userId: user.userId,
          username: user.username,
          displayName: user.displayName || user.username,
          hasVerifiedBadge: Boolean(user.hasVerifiedBadge),
          avatarUrl: "",
          roles: []
        };

        existing.roles.push({
          name: configuredRole.name,
          label: configuredRole.label || configuredRole.name,
          accent: configuredRole.accent || "default",
          description: configuredRole.description || ""
        });

        membersByUserId.set(user.userId, existing);
      }
    }

    const members = Array.from(membersByUserId.values()).sort((a, b) =>
      a.displayName.localeCompare(b.displayName)
    );

    const avatarMap = await getAvatarMap(members.map((member) => member.userId));

    for (const member of members) {
      member.avatarUrl = avatarMap.get(member.userId) || "";
    }

    return sendJson(res, 200, {
      groupId,
      configuredRoles: configuredRoles.map((role) => role.name),
      unresolvedRoles,
      members
    });
  } catch (error) {
    const isPrivacyError = error.status === 403;

    return sendJson(res, error.status || 500, {
      error: isPrivacyError
        ? "Roblox group member list is not publicly visible."
        : "Failed to load Roblox team data.",
      details: error.body || error.message
    });
  }
};

