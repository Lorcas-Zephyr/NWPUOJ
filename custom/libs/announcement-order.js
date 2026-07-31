'use strict';

const LEVEL_PRIORITY = Object.freeze({
  important: 0,
  warning: 1,
  info: 2
});

function startTime(announcement) {
  return Number(announcement.start_time || announcement.public_time || 0);
}

function announcementState(announcement, now) {
  const start = announcement.start_time == null ? null : Number(announcement.start_time);
  const end = announcement.end_time == null ? null : Number(announcement.end_time);
  if (start != null && start > now) return 'upcoming';
  if (end != null && end < now) return 'ended';
  return 'active';
}

function compareAnnouncements(a, b, now) {
  const stateOrder = { active: 0, upcoming: 1, ended: 2 };
  const aState = announcementState(a, now);
  const bState = announcementState(b, now);
  if (aState !== bState) return stateOrder[aState] - stateOrder[bState];

  if (aState === 'active') {
    const aPriority = LEVEL_PRIORITY[a.level] == null ? LEVEL_PRIORITY.info : LEVEL_PRIORITY[a.level];
    const bPriority = LEVEL_PRIORITY[b.level] == null ? LEVEL_PRIORITY.info : LEVEL_PRIORITY[b.level];
    if (aPriority !== bPriority) return aPriority - bPriority;
  }

  if (aState === 'upcoming') {
    const timeDifference = startTime(a) - startTime(b);
    if (timeDifference) return timeDifference;
  } else {
    const timeDifference = startTime(b) - startTime(a);
    if (timeDifference) return timeDifference;
  }

  return Number(b.id || 0) - Number(a.id || 0);
}

function sortAnnouncements(announcements, now = Math.floor(Date.now() / 1000)) {
  return announcements.sort((a, b) => compareAnnouncements(a, b, now));
}

module.exports = { announcementState, compareAnnouncements, sortAnnouncements };
