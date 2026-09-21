/**
 * Axis-constrained drag anchor: snaps a drag to horizontal or vertical axis
 * (in the anchor's rotated frame) while Shift is held. Used by paint, pen, and move tools.
 */
import { Point } from "../../core/math/point.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { KeyboardHandler } from "../../core/keyboard-handler.js";

/** @enum {number} */
const AxisLock = {
  Undecided: 0,
  Vertical: 1,
  Horizontal: 2,
};

class AxisDragAnchor {
  /**
   * @param {Point} anchorDocPoint Document-space anchor for the drag.
   * @param {number} [rotationRadians] Layer / path rotation in radians.
   */
  constructor(anchorDocPoint, rotationRadians = 0) {
    this.anchorDocPoint = anchorDocPoint;
    this.rotationRadians = rotationRadians;
    /** @type {number} @see AxisLock */
    this.axisLock = AxisLock.Undecided;
  }

  /**
   * @param {Point} docPoint Current pointer position in document space.
   * @param {KeyboardHandler} keyboard
   * @returns {Point}
   */
  constrainAxisDragPoint(docPoint, keyboard) {
    const anchor = this.anchorDocPoint;
    let offset = new Point(docPoint.x - anchor.x, docPoint.y - anchor.y);
    const rotationMatrix = new Matrix2D();
    rotationMatrix.rotate(-this.rotationRadians);
    offset = rotationMatrix.transformPoint(offset);

    if (this.axisLock === AxisLock.Undecided && !anchor.equals(docPoint)) {
      this.axisLock =
        Math.abs(offset.x) < Math.abs(offset.y) ? AxisLock.Vertical : AxisLock.Horizontal;
    }

    if (keyboard.isPressed(KeyboardHandler.Shift)) {
      if (this.axisLock === AxisLock.Vertical) offset.x = 0;
      if (this.axisLock === AxisLock.Horizontal) offset.y = 0;
    }

    rotationMatrix.invert();
    offset = rotationMatrix.transformPoint(offset);
    return new Point(anchor.x + offset.x, anchor.y + offset.y);
  }
}

export { AxisDragAnchor };
