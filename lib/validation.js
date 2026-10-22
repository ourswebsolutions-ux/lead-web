// Input rules shared by the admin API, the seed and the licence system (an
// email accepted by the desktop app's application form is always accepted
// as a user's email).

export const ID_RE = /^[A-Za-z0-9_-]{3,64}$/;
export const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]{1,189}\.[a-z]{2,24}$/i;
// ISO 8601 date-time with an explicit timezone (Z or ±hh:mm).
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
