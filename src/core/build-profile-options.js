import { discoverBuildProfiles, materializeCompileCommands, selectProfileSourceFiles } from './build-config.js';

export function selectedBuildProfile(root, options) {
  if (!options?.buildProfileId) return null;
  return discoverBuildProfiles(root).profiles.find(profile => profile.id === options.buildProfileId) || null;
}

/** 同一个配置可以应用到工作区、Git 或目录快照各自的源文件清单。 */
export function resolveBuildProfileOptions(root, parserId, options = {}, files = [],
  profile = selectedBuildProfile(root, options), cacheDir) {
  const resolved = { ...options };
  if (!profile) {
    delete resolved.buildProfileId;
  } else if (parserId === 'clang-ast') {
    resolved.compileCommandsPath = materializeCompileCommands(root, profile, { files, cacheDir }).compileCommandsPath;
    resolved.strictCompileCommands ??= true;
  } else if (parserId === 'builtin') {
    resolved.activeFiles = selectProfileSourceFiles(profile, files);
    resolved.defines = profile.defines || [];
    resolved.macroArgs = profile.macroArgs;
    resolved.compilationUnits = profile.compilationUnits || {};
    resolved.includeDirs = profile.includeDirs || [];
    resolved.includeOptions = profile.includeOptions;
    resolved.forcedIncludes = profile.forcedIncludes || [];
  }
  return resolved;
}
