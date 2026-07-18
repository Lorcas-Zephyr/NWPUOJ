const fs = require('fs');
const path = require('path');

const originalReaddir = fs.readdir;
fs.readdir = function orderedReaddir(directory, options, callback) {
  let actualOptions = options;
  let actualCallback = callback;
  if (typeof options === 'function') {
    actualCallback = options;
    actualOptions = undefined;
  }
  if (typeof actualCallback !== 'function') {
    return originalReaddir.apply(fs, arguments);
  }

  const wrappedCallback = function (error, files) {
    if (!error && Array.isArray(files) && path.resolve(String(directory)) === '/app/modules') {
      files.sort((left, right) => {
        const leftName = typeof left === 'string' ? left : left.name;
        const rightName = typeof right === 'string' ? right : right.name;
        const priorities = [
           '_request_security.js',
           '_admin_overview.js',
           '_admin_users.js',
           '_auth_security.js',
          'email_verification.js',
           '_identity_gate.js',
           '_user_avatar.js',
           '_contest_registration.js',
           '_contest_rating.js',
           '_user_privilege_loader.js',
           '_problem_bulk_import.js',
           '_help_page.js',
           '_submission_routes.js',
           '_problem_lifecycle_guard.js',
           '_contest_interactions.js',
           '_content_security.js'
        ];
        const leftPriority = priorities.indexOf(leftName);
        const rightPriority = priorities.indexOf(rightName);
        if (leftPriority !== -1 || rightPriority !== -1) {
          if (leftPriority === -1) return 1;
          if (rightPriority === -1) return -1;
          return leftPriority - rightPriority;
        }
        return leftName.localeCompare(rightName);
      });
    }
    actualCallback(error, files);
  };
  if (actualOptions === undefined) return originalReaddir.call(fs, directory, wrappedCallback);
  return originalReaddir.call(fs, directory, actualOptions, wrappedCallback);
};
