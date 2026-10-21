import numpy as np
import pytest

from weather_app import radar_nowcast as R

cv2 = pytest.importorskip("cv2")


def storm(cx, cy, size=1024, r=60, v=150):
    g = np.zeros((size, size), np.uint8)
    cv2.circle(g, (int(cx), int(cy)), r, v, -1)
    return cv2.GaussianBlur(g, (0, 0), 6)


def test_decode_universal_blue_colours():
    rgba = np.zeros((2, 3, 4), np.uint8)
    rgba[0, 0] = (0, 163, 224, 255)   # 20 dBZ
    rgba[0, 1] = (255, 170, 0, 255)   # 40 dBZ
    rgba[0, 2] = (0, 163, 224, 40)    # too faint: no rain
    out = R.decode(rgba)
    assert out[0, 0] == round(0.3 * 255) and out[0, 1] == round(0.7 * 255)
    assert out[0, 2] == 0 and out[1].sum() == 0


def test_storm_is_moved_along_its_motion():
    # A storm moving 30 px east every 30 minutes (zoom-5 pixels).
    first, mid, now = storm(300, 380), storm(330, 380), storm(360, 380)
    flow = R.motion(first, mid, now)
    world = now
    # 30 minutes ahead: centre near (390, 380) (tile 1, 1 covers 256–511).
    g = R.predict_tile(world, flow, 1, 1, 30)
    ys, xs = np.nonzero(g > 100)
    assert abs(xs.mean() + 256 - 390) < 8 and abs(ys.mean() + 256 - 380) < 8
    m = R.tile_motion(flow, 1, 1, world)
    assert m is not None and 60 < m[1] < 120  # moving towards the east


def test_colorize_and_overviews():
    img = R.colorize(np.full((256, 256), 200, np.uint8))
    assert img.shape == (256, 256, 4) and img[..., 3].min() == 255
    assert R.colorize(np.zeros((4, 4), np.uint8))[..., 3].max() == 0
    over = R.overviews({(17, 11): img})
    assert (4, 8, 5) in over and (0, 0, 0) in over and len(over) == R.ZOOM
