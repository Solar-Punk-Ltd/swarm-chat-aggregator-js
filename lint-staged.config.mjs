export default {
  '**/*.{ts,tsx,js,json}': (stagedFiles) => [`eslint .`, `prettier --write ${stagedFiles.join(' ')}`, 'tsc --noEmit'],
};
