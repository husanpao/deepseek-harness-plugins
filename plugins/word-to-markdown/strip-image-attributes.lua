-- Drop the image size attributes a Word document carries.
--
-- Word records explicit width/height on inserted pictures. Pandoc's GitHub-Flavored
-- Markdown writer cannot express those attributes, so it falls back to a raw
-- `<img src="...">` tag — which a renderer without raw-HTML support shows as
-- literal text, losing the picture entirely. Removing the attributes keeps the
-- image as Markdown `![](path)`, which every renderer understands. Logos and
-- screenshots scale to their container instead of their authored pixel size.
function Image(image)
  image.attributes.width = nil
  image.attributes.height = nil
  return image
end
