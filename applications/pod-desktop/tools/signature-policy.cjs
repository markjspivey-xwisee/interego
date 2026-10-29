module.exports = function signaturePolicy(status, signingRequested = false) {
  if (status === 'Valid') return 'signed';
  if (status === 'NotSigned' && !signingRequested) return 'unsigned-preview';
  throw new Error(`Installer signature inspection returned ${String(status)}. This artifact cannot be distributed.`);
};
