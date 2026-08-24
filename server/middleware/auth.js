const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

function issueToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

// Reads the JWT from the `token` cookie if present. Does NOT reject the
// request when there's no token — many routes (e.g. an "open_to_all" live
// class) must stay reachable by anonymous/non-registered visitors, so
// access decisions happen in the route itself, not here.
function attachUser(req, res, next) {
  const token = req.cookies?.token;
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch {
      req.user = null;
    }
  } else {
    req.user = null;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Login required." });
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: `This action needs a ${role} account.` });
    }
    next();
  };
}

module.exports = { issueToken, attachUser, requireAuth, requireRole, JWT_SECRET };
