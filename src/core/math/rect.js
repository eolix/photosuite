/**
 * Axis-aligned rectangle (x, y, width, height). Width and height may be zero or
 * negative; {@link Rect#isEmpty} treats non-positive extent as empty.
 */
function Rect(x, y, width, height) {
  this.x = x || 0;
  this.y = y || 0;
  this.width = width || 0;
  this.height = height || 0;
}

Rect.scratchPoint = new Float32Array(2);

Rect.prototype.area = function () {
  return this.width * this.height;
};

Rect.prototype.clone = function () {
  return new Rect(this.x, this.y, this.width, this.height);
};

Rect.prototype.contains = function (px, py) {
  const x = this.x;
  const y = this.y;
  return px >= x && px <= x + this.width && py >= y && py <= y + this.height;
};

Rect.prototype.containsPoint = function (point) {
  return this.contains(point.x, point.y);
};

Rect.prototype.containsRect = function (other) {
  const x = this.x;
  const y = this.y;
  const right = x + this.width;
  const bottom = y + this.height;
  const ox = other.x;
  const oy = other.y;
  return x <= ox && y <= oy && ox + other.width <= right && oy + other.height <= bottom;
};

Rect.prototype.copyFrom = function (other) {
  this.x = other.x;
  this.y = other.y;
  this.width = other.width;
  this.height = other.height;
};

Rect.prototype.equals = function (other) {
  return (
    this.x == other.x &&
    this.y == other.y &&
    this.width == other.width &&
    this.height == other.height
  );
};

Rect.prototype.inflate = function (dx, dy) {
  this.x -= dx;
  this.y -= dy;
  this.width += dx + dx;
  this.height += dy + dy;
};

Rect.prototype.inflateByPoint = function (point) {
  this.inflate(point.x, point.y);
};

Rect.prototype.intersect = function (other) {
  const x = this.x;
  const y = this.y;
  const left = x > other.x ? x : other.x;
  const top = y > other.y ? y : other.y;
  const right = x + this.width < other.x + other.width ? x + this.width : other.x + other.width;
  const bottom = y + this.height < other.y + other.height ? y + this.height : other.y + other.height;
  if (right < left || bottom < top) {
    return new Rect();
  }
  return new Rect(left, top, right - left, bottom - top);
};

Rect.prototype.overlaps = function (other) {
  const x = this.x;
  const y = this.y;
  const ox = other.x;
  const oy = other.y;
  return !(
    oy + other.height < y ||
    ox > x + this.width ||
    oy > y + this.height ||
    ox + other.width < x
  );
};

Rect.prototype.isEmpty = function () {
  return this.width <= 0 || this.height <= 0;
};

Rect.prototype.offset = function (dx, dy) {
  this.x += dx;
  this.y += dy;
};

Rect.prototype.offsetByPoint = function (point) {
  this.offset(point.x, point.y);
};

Rect.prototype.reset = function () {
  this.x = 0;
  this.y = 0;
  this.width = 0;
  this.height = 0;
};

Rect.prototype.setXY = function (x, y, width, height) {
  this.x = x;
  this.y = y;
  this.width = width;
  this.height = height;
};

Rect.prototype.union = function (other) {
  if (this.isEmpty()) {
    return other.clone();
  }
  if (other.isEmpty()) {
    return this.clone();
  }
  const out = this.clone();
  out.expandToInclude(other);
  return out;
};

Rect.prototype.expandToInclude = function (other) {
  if (other.isEmpty()) {
    return;
  }
  if (this.isEmpty()) {
    this.copyFrom(other);
    return;
  }
  const ox = other.x;
  const oy = other.y;
  this.expandToPoint(ox, oy);
  this.expandToPoint(ox + other.width, oy + other.height);
};

Rect.prototype.expandToPoint = function (px, py) {
  const x = this.x;
  const y = this.y;
  const minX = x < px ? x : px;
  const minY = y < py ? y : py;
  const right = x + this.width;
  const bottom = y + this.height;
  const maxX = right > px ? right : px;
  const maxY = bottom > py ? bottom : py;
  this.x = minX;
  this.y = minY;
  this.width = maxX - minX;
  this.height = maxY - minY;
};

Rect.prototype.setToPoint = function (x, y) {
  this.x = x;
  this.y = y;
  this.width = 0;
  this.height = 0;
};

export { Rect };
