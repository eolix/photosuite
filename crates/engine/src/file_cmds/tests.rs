use super::*;

fn tmp(name: &str) -> String {
    let d = std::env::temp_dir().join(format!("photosuite-file-cmds-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d.to_string_lossy().into_owned()
}

fn session(w: u32, h: u32, depth: u32) -> Session {
    let mut s = Session::new();
    s.execute("file.new", json!({"width": w, "height": h, "depth": depth})).unwrap();
    s
}

fn doc(s: &Session) -> &Document {
    &s.active().unwrap().doc
}

/// Writes a solid-colour PNG of `w × h` and returns its path.
fn png(dir: &str, name: &str, w: u32, h: u32, color: &str) -> String {
    let mut s = Session::new();
    s.execute("file.new", json!({"width": w, "height": h, "background": color})).unwrap();
    let path = join(dir, name);
    save_doc(doc(&s), &path, None).unwrap();
    path
}

fn composite(s: &Session, x: i32, y: i32) -> [f32; 4] {
    let b = photosuite_compose::render(doc(s), Rect::new(x, y, x + 1, y + 1));
    b.px[0]
}

#[test]
fn close_all_and_close_others() {
    let mut s = session(8, 8, 8);
    s.execute("file.new", json!({"width": 9, "height": 9})).unwrap();
    s.execute("file.new", json!({"width": 10, "height": 10})).unwrap();
    s.set_active(1);
    assert_eq!(s.execute("file.closeOthers", json!({})).unwrap()["closed"], 2);
    assert_eq!(s.documents().len(), 1);
    assert_eq!(doc(&s).size.width, 9);
    assert_eq!(s.active_index(), Some(0));
    assert!(s.execute("file.closeOthers", json!({"document": 5})).is_err());
    s.execute("file.new", json!({})).unwrap();
    assert_eq!(s.execute("file.closeAll", json!({})).unwrap()["closed"], 2);
    assert!(s.documents().is_empty());
    assert!(!s.is_enabled("file.closeAll"));
}

#[test]
fn camera_raw_opens_as_16_bit_with_notes() {
    use photosuite_raw::testgen::{DngSpec, mosaic, scene};
    let (w, h) = (24, 16);
    let mut spec = DngSpec::cfa(w, h, mosaic(&scene(w, h), w, [0, 1, 1, 2], 0, 65535));
    spec.as_shot_neutral = Some([0.5, 1.0, 0.7]);
    let mut s = Session::new();
    let r = open_bytes_as(&mut s, "IMG_0001.dng", &spec.build(), None, None).unwrap();
    assert!(r["warnings"].as_array().is_some_and(|w| w.iter().any(|m| m.as_str().is_some_and(|m| m.contains("DNG")))), "{r}");
    assert_eq!((doc(&s).size.width, doc(&s).size.height), (24, 16));
    assert_eq!(doc(&s).depth, photosuite_color::SampleType::U16);
    // Damaged raw data is an error, not a crash.
    let mut bad = spec.build();
    bad.truncate(bad.len() / 2);
    assert!(open_bytes_as(&mut s, "bad.dng", &bad, None, None).is_err());
}

#[test]
fn revert_reloads_as_one_undoable_step() {
    let dir = tmp("revert");
    let path = png(&dir, "a.png", 16, 12, "#ff0000");
    let mut s = Session::new();
    assert!(!s.is_enabled("file.revert"));
    let bytes = std::fs::read(&path).unwrap();
    open_bytes_as(&mut s, &path, &bytes, None, Some(path.clone())).unwrap();
    let id = doc(&s).id;
    assert!(s.is_enabled("file.revert"));
    s.execute("layer.new.layer", json!({})).unwrap();
    s.execute("edit.fill", json!({"color": "#0000ff"})).unwrap();
    assert!(s.active().unwrap().is_dirty());
    s.execute("file.revert", json!({})).unwrap();
    assert_eq!(doc(&s).layers.len(), 1);
    assert_eq!(doc(&s).id, id, "identity kept");
    assert!(!s.active().unwrap().is_dirty());
    assert!(composite(&s, 3, 3)[0] > 0.99);
    // Revert is a history state: undo brings the edits back.
    assert!(s.undo());
    assert_eq!(doc(&s).layers.len(), 2);
    // An unsaved document cannot revert.
    s.execute("file.new", json!({})).unwrap();
    assert!(s.execute("file.revert", json!({})).is_err());
}

#[test]
fn save_a_copy_keeps_path_and_dirty_state() {
    let dir = tmp("copy");
    let mut s = session(20, 10, 16);
    s.execute("layer.new.layer", json!({})).unwrap();
    let rev = s.active().unwrap().revision;
    let out = join(&dir, "copy.psd");
    s.execute("file.saveACopy", json!({"path": out})).unwrap();
    assert!(std::fs::metadata(&out).unwrap().len() > 0);
    assert_eq!(s.active().unwrap().path, None);
    assert_eq!(s.active().unwrap().revision, rev);
    assert!(s.active().unwrap().is_dirty());
    let back = photosuite_io::import("copy.psd", &std::fs::read(&out).unwrap()).unwrap().document;
    assert_eq!(back.layers.len(), 2);
    assert_eq!(back.depth, photosuite_color::SampleType::U16);
    // Flattened copy.
    let flat = join(&dir, "flat.psd");
    s.execute("file.saveACopy", json!({"path": flat, "layers": false})).unwrap();
    assert_eq!(photosuite_io::import("flat.psd", &std::fs::read(&flat).unwrap()).unwrap().document.layers.len(), 1);
    assert!(s.execute("file.saveACopy", json!({})).is_err());
}

#[test]
fn open_as_forces_the_decoder() {
    let dir = tmp("openas");
    let path = png(&dir, "a.png", 6, 5, "#00ff00");
    let renamed = join(&dir, "mystery.bin");
    std::fs::copy(&path, &renamed).unwrap();
    let mut s = Session::new();
    s.execute("file.openAs", json!({"path": renamed, "as": "png"})).unwrap();
    assert_eq!(doc(&s).size.width, 6);
    assert_eq!(doc(&s).name, "mystery.bin");
    assert_eq!(s.active().unwrap().path.as_deref(), Some(renamed.as_str()));
    assert!(s.execute("file.openAs", json!({"path": join(&dir, "missing.png")})).is_err());
}

#[test]
fn place_embedded_centres_fits_and_embeds() {
    let dir = tmp("place");
    let big = png(&dir, "big.png", 200, 100, "#ff0000");
    let small = png(&dir, "small.png", 10, 10, "#0000ff");
    for depth in [8, 16, 32] {
        let mut s = session(100, 100, depth);
        let r = s.execute("file.placeEmbedded", json!({"path": big})).unwrap();
        assert!((r["scale"].as_f64().unwrap() - 50.0).abs() < 1e-9);
        let d = s.active().unwrap();
        let l = d.doc.layer(d.active_layer.unwrap()).unwrap();
        assert_eq!(l.name, "big");
        let LayerContent::Smart(so) = &l.content else { panic!("smart object expected") };
        assert!(matches!(&so.source, SmartSource::Embedded { file_name, bytes } if file_name == "big.png" && !bytes.is_empty()));
        assert_eq!(so.transform.m[0], 0.5);
        // Fitted to the canvas width, centred vertically: rows 25..75 red.
        assert!(composite(&s, 50, 50)[0] > 0.99 && composite(&s, 50, 50)[2] < 0.01);
        assert!(composite(&s, 50, 10)[1] > 0.99, "white background above");
        // Small images keep their size, centred.
        s.execute("file.placeLinked", json!({"path": small})).unwrap();
        assert!(composite(&s, 50, 50)[2] > 0.99);
        assert!(composite(&s, 40, 40)[2] < 0.01);
        let d = s.active().unwrap();
        let l = d.doc.layer(d.active_layer.unwrap()).unwrap();
        assert!(matches!(&l.content, LayerContent::Smart(so) if matches!(&so.source, SmartSource::Linked { path } if path == &small)));
        // One step each.
        assert!(s.undo() && s.undo());
        assert_eq!(doc(&s).layers.len(), 1);
    }
}

/// A 40×20 JPEG (left half red, right half blue) tagged EXIF Orientation = 6: shown upright it
/// is 20×40, red on top.
fn rotated_jpeg(dir: &str) -> String {
    let px: Vec<u8> = (0..20).flat_map(|_| (0..40).flat_map(|x| if x < 20 { [230, 20, 20] } else { [20, 20, 230] })).collect();
    let img = photosuite_codecs::Image::from_u8(40, 20, photosuite_codecs::ChannelLayout::Rgb, px).unwrap();
    let jpeg = photosuite_codecs::encode(&img, photosuite_codecs::Format::Jpeg, &Default::default()).unwrap();
    let mut seg = b"Exif\0\0II*\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0".to_vec();
    let mut file = vec![0xFF, 0xD8, 0xFF, 0xE1];
    file.extend_from_slice(&((seg.len() + 2) as u16).to_be_bytes());
    file.append(&mut seg);
    file.extend_from_slice(&jpeg[2..]);
    let path = join(dir, "IMG_0001.jpg");
    std::fs::write(&path, file).unwrap();
    path
}

#[test]
fn rotated_jpegs_open_and_place_upright() {
    let dir = tmp("orientation");
    let path = rotated_jpeg(&dir);
    let mut s = Session::new();
    s.execute("file.openAs", json!({"path": path, "as": "jpg"})).unwrap();
    assert_eq!((doc(&s).size.width, doc(&s).size.height), (20, 40));
    assert!(composite(&s, 10, 5)[0] > 0.8 && composite(&s, 10, 35)[2] > 0.8, "red on top, blue below");
    // Placed as a smart object: upright too, and it renders upright from its embedded bytes.
    let mut s = session(100, 100, 8);
    let r = s.execute("file.placeEmbedded", json!({"path": path})).unwrap();
    assert_eq!(r["bounds"], json!([40.0, 30.0, 60.0, 70.0]));
    assert!(composite(&s, 50, 35)[0] > 0.8 && composite(&s, 50, 65)[2] > 0.8);
}

#[test]
fn file_info_round_trips_through_xmp_and_psd() {
    let mut s = session(8, 8, 8);
    let empty = s.execute("file.fileInfo", json!({})).unwrap();
    assert_eq!(empty["title"], "");
    assert!(!s.undo(), "reading is not a history step");
    s.execute("file.fileInfo", json!({"title": "Starry <Night>", "author": "V. van Gogh", "keywords": ["stars", "night"], "copyright": "Public domain", "copyrightStatus": "publicDomain", "description": "Oil & canvas"})).unwrap();
    let info = s.execute("file.fileInfo", json!({})).unwrap();
    assert_eq!(info["title"], "Starry <Night>");
    assert_eq!(info["author"], "V. van Gogh");
    assert_eq!(info["keywords"], json!(["stars", "night"]));
    assert_eq!(info["description"], "Oil & canvas");
    assert_eq!(info["copyrightStatus"], "publicDomain");
    // Editing one field keeps the others and replaces, not duplicates.
    s.execute("file.fileInfo", json!({"title": "The Starry Night"})).unwrap();
    let xmp = doc(&s).metadata.xmp.clone().unwrap();
    assert_eq!(xmp.matches("<dc:title>").count(), 1);
    assert_eq!(read_file_info(Some(&xmp))["author"], "V. van Gogh");
    // PSD round trip.
    let (bytes, _) = encode(doc(&s), "x.psd", None).unwrap();
    let back = photosuite_io::import("x.psd", &bytes).unwrap().document;
    let info = read_file_info(back.metadata.xmp.as_deref());
    assert_eq!(info["title"], "The Starry Night");
    assert_eq!(info["keywords"], json!(["stars", "night"]));
    // Foreign XMP (attribute form, other namespaces) keeps its other properties.
    let foreign = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="Other App" photoshop:AuthorsPosition="Painter"/></rdf:RDF></x:xmpmeta>"#;
    assert_eq!(read_file_info(Some(foreign))["authorTitle"], "Painter");
    let out = write_file_info(Some(foreign), &json!({"authorTitle": "Artist"}));
    assert!(out.contains("xmp:CreatorTool=\"Other App\""));
    assert_eq!(read_file_info(Some(&out))["authorTitle"], "Artist");
}

#[test]
fn fit_image_and_conditional_mode_change() {
    let mut s = session(400, 200, 8);
    s.execute("file.automate.fitImage", json!({"width": 100, "height": 100})).unwrap();
    assert_eq!((doc(&s).size.width, doc(&s).size.height), (100, 50));
    let r = s.execute("file.automate.fitImage", json!({"width": 1000, "height": 1000, "dontEnlarge": true})).unwrap();
    assert_eq!(r["changed"], false);
    s.execute("file.automate.fitImage", json!({"width": 1000, "height": 1000})).unwrap();
    assert_eq!(doc(&s).size.width, 1000);
    let r = s.execute("file.automate.conditionalModeChange", json!({"from": ["cmyk"], "to": "grayscale"})).unwrap();
    assert_eq!(r["changed"], false);
    s.execute("file.automate.conditionalModeChange", json!({"from": ["rgb", "lab"], "to": "grayscale"})).unwrap();
    assert_eq!(doc(&s).mode, ColorMode::Grayscale);
    s.execute("file.automate.conditionalModeChange", json!({"to": "rgb"})).unwrap();
    assert_eq!(doc(&s).mode, ColorMode::Rgb);
    assert!(s.execute("file.automate.conditionalModeChange", json!({"to": "duotone"})).is_err());
}

#[test]
fn flatten_all_layer_effects_and_masks() {
    for depth in [8, 16, 32] {
        let mut s = session(40, 40, depth);
        s.execute("layer.new.layer", json!({})).unwrap();
        s.execute("select.rect", json!({"x": 10, "y": 10, "width": 20, "height": 20})).unwrap();
        s.execute("edit.fill", json!({"color": "#ff0000"})).unwrap();
        s.execute("select.deselect", json!({})).unwrap();
        let id = s.active().unwrap().active_layer.unwrap();
        s.edit("fx", |doc, _| {
            let l = doc.layer_mut(id).unwrap();
            l.effects.enabled = true;
            l.effects.items.push(photosuite_doc::Effect::ColorOverlay {
                common: photosuite_doc::effects::FxCommon::new(photosuite_color::BlendMode::Normal, 1.0),
                color: photosuite_color::Color::rgb(0.0, 1.0, 0.0),
            });
            Ok(())
        })
        .unwrap();
        let before = composite(&s, 15, 15);
        assert!(before[1] > 0.99, "overlay renders green");
        assert_eq!(s.execute("file.scripts.flattenAllLayerEffects", json!({})).unwrap()["flattened"], 1);
        let l = doc(&s).layer(id).unwrap();
        assert!(l.effects.items.is_empty() && matches!(l.content, LayerContent::Raster(_)));
        let after = composite(&s, 15, 15);
        assert!((after[1] - before[1]).abs() < 0.01 && after[0] < 0.01, "{after:?}");
        // Masks: hide the left half, flatten, mask gone, pixels gone.
        s.execute("select.rect", json!({"x": 0, "y": 0, "width": 20, "height": 40})).unwrap();
        s.execute("select.inverse", json!({})).unwrap();
        s.execute("layer.layerMask.revealSelection", json!({})).unwrap();
        s.execute("select.deselect", json!({})).unwrap();
        assert!(composite(&s, 15, 15)[1] > 0.99 && composite(&s, 15, 15)[0] > 0.99, "white shows through the mask");
        let r = s.execute("file.scripts.flattenAllMasks", json!({})).unwrap();
        assert_eq!(r["flattened"], 1);
        let l = doc(&s).layer(id).unwrap();
        assert!(l.mask.is_none());
        assert!(l.surface().unwrap().content_bounds().x0 >= 20);
        assert!(composite(&s, 25, 15)[1] > 0.99 && composite(&s, 25, 15)[0] < 0.01);
        // Each script is a single history step.
        assert!(s.undo());
        assert!(doc(&s).layer(id).unwrap().mask.is_some());
    }
}

#[test]
fn layers_to_files_writes_each_visible_layer() {
    let dir = tmp("layers");
    let mut s = session(12, 12, 8);
    s.execute("layer.new.layer", json!({"name": "Ink/1"})).unwrap();
    s.execute("layer.new.layer", json!({"name": "Hidden"})).unwrap();
    s.execute("layer.setProps", json!({"visible": false})).unwrap();
    let r = s.execute("file.export.layersToFiles", json!({"dir": dir, "prefix": "doc", "format": "png"})).unwrap();
    let files: Vec<String> = r["files"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    assert_eq!(files.len(), 2, "{files:?}");
    assert!(files[0].ends_with("doc_0000_Ink_1.png"), "{files:?}");
    assert!(files.iter().all(|f| std::path::Path::new(f).is_file()));
    let r = s.execute("file.export.layersToFiles", json!({"dir": dir, "visibleOnly": false, "format": "psd"})).unwrap();
    assert_eq!(r["files"].as_array().unwrap().len(), 3);
}

#[test]
fn load_files_into_stack_and_image_processor_and_batch() {
    let dir = tmp("batch");
    let input = join(&dir, "in");
    std::fs::create_dir_all(&input).unwrap();
    let a = png(&input, "a.png", 40, 20, "#ff0000");
    let b = png(&input, "b.png", 30, 30, "#0000ff");
    std::fs::write(join(&input, "notes.txt"), "not an image").unwrap();
    let mut s = Session::new();
    let r = s.execute("file.scripts.loadFilesIntoStack", json!({"paths": [a, b]})).unwrap();
    assert_eq!(r["layers"], 2);
    assert_eq!((doc(&s).size.width, doc(&s).size.height), (40, 30));
    assert_eq!(doc(&s).layers[0].name, "a.png");
    // Image Processor: fit into 20×20 JPEGs.
    let out = join(&dir, "jpg");
    let r = s.execute("file.scripts.imageProcessor", json!({"input": input, "output": out, "format": "jpg", "width": 20, "height": 20})).unwrap();
    let files = r["files"].as_array().unwrap();
    assert_eq!(files.len(), 2, "{r}");
    let back = photosuite_io::import("a.jpg", &std::fs::read(files[0].as_str().unwrap()).unwrap()).unwrap().document;
    assert_eq!((back.size.width, back.size.height), (20, 10));
    // Batch: run an action (invert) over the folder, save PNGs.
    let out = join(&dir, "png");
    let r = s.execute("file.automate.batch", json!({"steps": [["image.adjustments.invert", {}]], "input": input, "output": out, "format": "png"})).unwrap();
    assert_eq!(r["files"].as_array().unwrap().len(), 2, "{r}");
    assert!(r["errors"].as_array().unwrap().is_empty());
    let inv = photosuite_io::import("a.png", &std::fs::read(join(&out, "a.png")).unwrap()).unwrap().document;
    let px = photosuite_compose::render(&inv, Rect::new(1, 1, 2, 2)).px[0];
    assert!(px[0] < 0.01 && px[1] > 0.99 && px[2] > 0.99, "red inverted to cyan: {px:?}");
    assert!(s.execute("file.automate.batch", json!({"steps": [["no.such.command", {}]], "input": input, "output": out})).is_err());
}

#[test]
fn color_lookup_table_bakes_the_adjustment_stack() {
    let mut s = session(8, 8, 8);
    assert!(!s.is_enabled("file.export.colorLookupTables"));
    s.execute("layer.newAdjustmentLayer.invert", json!({})).unwrap();
    let r = s.execute("file.export.colorLookupTables", json!({"size": 3})).unwrap();
    let cube = r["cube"].as_str().unwrap();
    assert!(cube.contains("LUT_3D_SIZE 3"));
    let rows: Vec<Vec<f32>> =
        cube.lines().filter(|l| l.chars().next().is_some_and(|c| c.is_ascii_digit())).map(|l| l.split(' ').map(|v| v.parse().unwrap()).collect()).collect();
    assert_eq!(rows.len(), 27);
    // First entry (0,0,0) → white; second (r = 0.5) → 0.5; last (1,1,1) → black.
    assert!(rows[0].iter().all(|v| (v - 1.0).abs() < 1e-3), "{:?}", rows[0]);
    assert!((rows[1][0] - 0.5).abs() < 0.01 && (rows[1][1] - 1.0).abs() < 1e-3);
    assert!(rows[2][0].abs() < 1e-3 && (rows[2][2] - 1.0).abs() < 1e-3, "red fastest");
    assert!(rows[26].iter().all(|v| v.abs() < 1e-3));
    let dir = tmp("lut");
    let path = join(&dir, "invert.cube");
    s.execute("file.export.colorLookupTables", json!({"path": path, "size": 17})).unwrap();
    assert!(std::fs::read_to_string(&path).unwrap().contains("LUT_3D_SIZE 17"));
}

#[test]
fn guide_layouts() {
    let mut s = session(100, 50, 8);
    let r = s.execute("view.newGuideLayout", json!({"columns": 2, "gutter": 10, "margin": [5, 10, 5, 10]})).unwrap();
    assert_eq!(r["vertical"], 4);
    let g = &doc(&s).guides;
    assert_eq!(g.vertical, vec![10.0, 90.0, 45.0, 55.0]);
    assert_eq!(g.horizontal, vec![5.0, 45.0]);
    s.execute("view.newGuideLayout", json!({"rows": 2, "clearExisting": true})).unwrap();
    let g = &doc(&s).guides;
    assert!(g.vertical.is_empty());
    assert_eq!(g.horizontal, vec![0.0, 25.0, 50.0]);
    // Fixed-width centred columns.
    s.execute("view.newGuideLayout", json!({"columns": 2, "width": 20, "gutter": 10, "centerColumns": true, "clearExisting": true})).unwrap();
    assert_eq!(doc(&s).guides.vertical, vec![25.0, 45.0, 55.0, 75.0]);
    assert!(s.execute("view.newGuideLayout", json!({})).is_err());
    assert_eq!(s.execute("view.clearCanvasGuides", json!({})).unwrap()["cleared"], 4);
    assert!(doc(&s).guides.vertical.is_empty());
    assert!(!s.is_enabled("view.newGuidesFromShape"));
    s.execute("shape.create", json!({"kind": "rect", "rect": [10, 10, 40, 20]})).unwrap();
    s.execute("view.newGuidesFromShape", json!({})).unwrap();
    let g = &doc(&s).guides;
    assert_eq!(g.vertical, vec![10.0, 30.0, 50.0]);
    assert_eq!(g.horizontal, vec![10.0, 20.0, 30.0]);
}

#[test]
fn import_pdf_opens_the_chosen_page_at_a_resolution() {
    // Two 1 in × 1 in pages (72 × 72 px at 72 ppi): red, then blue.
    let page = |c: [u8; 3]| {
        let rgb: Vec<u8> = (0..72 * 72).flat_map(|_| c).collect();
        let img = photosuite_codecs::Image::from_u8(72, 72, photosuite_codecs::ChannelLayout::Rgb, rgb).unwrap();
        let jpeg = photosuite_codecs::encode(&img, photosuite_codecs::Format::Jpeg, &photosuite_codecs::EncodeOptions::default()).unwrap();
        (72u32, 72u32, 72.0f32, jpeg)
    };
    let pdf = photosuite_io::pdf::raster_pdf(&[page([255, 0, 0]), page([0, 0, 255])]);
    let dir = std::env::temp_dir().join(format!("pc-pdf-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("two.pdf").to_string_lossy().into_owned();
    std::fs::write(&path, &pdf).unwrap();
    assert_eq!(pdf_pages(&pdf), 2);
    let mut s = Session::new();
    let r = s.execute("file.importPdf", json!({"path": path, "page": 2, "resolution": 144})).unwrap();
    assert_eq!(r["pages"], 2);
    let st = s.active().unwrap();
    assert_eq!((st.doc.size.width, st.doc.size.height), (144, 144));
    assert_eq!(st.doc.name, "two.pdf (page 2)");
    assert!(st.path.is_none(), "opens untitled");
    let px = st.doc.layers[0].surface().unwrap().rgba(72, 72);
    assert!(px[2] > 0.9 && px[0] < 0.1, "page 2 is blue: {px:?}");
    assert!(s.execute("file.importPdf", json!({"path": path, "page": 5})).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn only_layered_files_save_in_place() {
    for path in ["a.psd", "dir/a.PSB", r"C:\w\a.pcraft", "my.dir/a.psd"] {
        assert!(saves_in_place(path), "{path}");
    }
    // Flat formats, no extension, a dotted folder with an extensionless file, a dot file.
    for path in ["a.png", "a.jpg", "a", "my.psd/a", ".psd", "a.", ""] {
        assert!(!saves_in_place(path), "{path}");
    }
    assert_eq!(extension("dir/Photo.JPEG").as_deref(), Some("jpeg"));
    assert_eq!(extension("my.dir/name"), None);
}

#[test]
fn templates_open_untitled_without_their_path() {
    assert!(is_template("dir/card.PSDT") && !is_template("card.psd") && !is_template("psdt"));
    let dir = tmp("template");
    let path = format!("{dir}/card.psdt");
    let mut s = session(8, 8, 8);
    std::fs::write(&path, encode(doc(&s), "x.psd", None).unwrap().0).unwrap();
    s.execute("file.openAs", json!({"path": path})).unwrap();
    s.execute("file.openAs", json!({"path": path, "as": "psd"})).unwrap();
    let opened: Vec<_> = s.documents()[1..].iter().map(|d| (d.doc.name.as_str(), d.path.as_deref())).collect();
    assert_eq!(opened, [("Untitled-1", None), ("Untitled-2", None)]);
}

/// Two inputs with one output name: the first result is kept and the second is an error, never
/// a silent overwrite listed as written (#422).
#[test]
fn batch_reports_inputs_that_share_an_output_name() {
    let dir = tmp("collide");
    let input = join(&dir, "in");
    std::fs::create_dir_all(&input).unwrap();
    png(&input, "a.png", 8, 8, "#ff0000");
    let mut s = Session::new();
    s.execute("file.new", json!({"width": 8, "height": 8, "background": "#0000ff"})).unwrap();
    save_doc(doc(&s), &join(&input, "a.jpg"), None).unwrap();
    png(&input, "B.png", 8, 8, "#00ff00");
    png(&input, "b.tif", 8, 8, "#00ff00");
    for (cmd, extra) in [
        ("file.automate.batch", json!({"steps": [], "format": "jpg"})),
        ("file.scripts.imageProcessor", json!({})),
        ("file.automate.lensCorrection", json!({"format": "jpg"})),
    ] {
        let out = join(&dir, cmd);
        let mut p = extra;
        p["input"] = json!(input);
        p["output"] = json!(out);
        let r = s.execute(cmd, p).unwrap();
        let files = r["files"].as_array().unwrap();
        let errors = r["errors"].as_array().unwrap();
        // `a.*` and `B.png`/`b.tif` (names that differ only in case) each collide once.
        assert_eq!((files.len(), errors.len()), (2, 2), "{cmd}: {r}");
        assert!(errors.iter().all(|e| e["error"].as_str().unwrap().contains("not written")), "{r}");
        let mut written: Vec<_> = files.iter().map(|f| f.as_str().unwrap().to_lowercase()).collect();
        written.dedup();
        assert_eq!(written.len(), 2, "each listed file is distinct: {r}");
    }
    // Keeping each file's format, nothing collides.
    let out = join(&dir, "same");
    let r = s.execute("file.automate.batch", json!({"steps": [], "input": input, "output": out})).unwrap();
    assert_eq!((r["files"].as_array().unwrap().len(), r["errors"].as_array().unwrap().len()), (4, 0), "{r}");
    // A droplet over two folders holding the same name.
    let other = join(&dir, "other");
    std::fs::create_dir_all(&other).unwrap();
    png(&other, "a.png", 8, 8, "#ffffff");
    let droplet = join(&dir, "d.pcdroplet");
    std::fs::write(&droplet, json!({"photosuiteDroplet": 1, "name": "d", "action": {"steps": []}, "options": {"format": "png"}}).to_string()).unwrap();
    let out = join(&dir, "droplet");
    let r = s.execute("file.automate.runDroplet", json!({"droplet": droplet, "input": [join(&input, "a.png"), other], "output": out})).unwrap();
    assert_eq!((r["files"].as_array().unwrap().len(), r["errors"].as_array().unwrap().len()), (1, 1), "{r}");
    let kept = photosuite_io::import("a.png", &std::fs::read(join(&out, "a.png")).unwrap()).unwrap().document;
    let px = photosuite_compose::render(&kept, Rect::new(1, 1, 2, 2)).px[0];
    assert!(px[0] > 0.99 && px[1] < 0.01, "the first input's result is kept: {px:?}");
}
