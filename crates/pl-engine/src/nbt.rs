//! Lecture et écriture du format NBT non compressé (ex. `servers.dat`).
//!
//! Tout l'arbre est conservé tel quel : réécrire un fichier ne perd aucune
//! donnée, même inconnue. Les chaînes utilisent l'UTF-8 « modifié » de Java,
//! indispensable pour les émojis et caractères spéciaux.

use anyhow::{Result, bail};

#[derive(Debug, Clone, PartialEq)]
pub enum Tag {
    Byte(i8),
    Short(i16),
    Int(i32),
    Long(i64),
    Float(f32),
    Double(f64),
    ByteArray(Vec<i8>),
    String(String),
    /// Type des éléments + éléments.
    List(u8, Vec<Tag>),
    /// Champs dans leur ordre d'origine.
    Compound(Vec<(String, Tag)>),
    IntArray(Vec<i32>),
    LongArray(Vec<i64>),
}

const END: u8 = 0;

impl Tag {
    pub fn id(&self) -> u8 {
        match self {
            Tag::Byte(_) => 1,
            Tag::Short(_) => 2,
            Tag::Int(_) => 3,
            Tag::Long(_) => 4,
            Tag::Float(_) => 5,
            Tag::Double(_) => 6,
            Tag::ByteArray(_) => 7,
            Tag::String(_) => 8,
            Tag::List(..) => 9,
            Tag::Compound(_) => 10,
            Tag::IntArray(_) => 11,
            Tag::LongArray(_) => 12,
        }
    }

    pub fn get(&self, key: &str) -> Option<&Tag> {
        match self {
            Tag::Compound(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Tag::String(s) => Some(s),
            _ => None,
        }
    }
}

/// Lit un fichier NBT complet : `(nom de la racine, racine)`.
pub fn read(data: &[u8]) -> Result<(String, Tag)> {
    let mut r = Reader { data, pos: 0 };
    let id = r.u8()?;
    if id != 10 {
        bail!("racine NBT invalide (type {id})");
    }
    let name = r.string()?;
    let root = r.payload(id, 0)?;
    if r.pos != data.len() {
        bail!("données en trop après la racine NBT");
    }
    Ok((name, root))
}

pub fn write(name: &str, root: &Tag) -> Vec<u8> {
    let mut out = vec![root.id()];
    write_string(&mut out, name);
    write_payload(&mut out, root);
    out
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8]> {
        let end = self.pos.checked_add(n).filter(|&e| e <= self.data.len());
        let Some(end) = end else { bail!("fichier NBT tronqué") };
        let slice = &self.data[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N]> {
        Ok(self.take(N)?.try_into().expect("taille exacte"))
    }

    fn len(&mut self) -> Result<usize> {
        let n = i32::from_be_bytes(self.array()?);
        if n < 0 {
            bail!("longueur NBT négative");
        }
        Ok(n as usize)
    }

    fn string(&mut self) -> Result<String> {
        let n = u16::from_be_bytes(self.array()?) as usize;
        Ok(decode_mutf8(self.take(n)?))
    }

    fn payload(&mut self, id: u8, depth: usize) -> Result<Tag> {
        // Un fichier piégé ne doit pas pouvoir faire déborder la pile.
        if depth > 512 {
            bail!("NBT trop imbriqué");
        }
        Ok(match id {
            1 => Tag::Byte(self.u8()? as i8),
            2 => Tag::Short(i16::from_be_bytes(self.array()?)),
            3 => Tag::Int(i32::from_be_bytes(self.array()?)),
            4 => Tag::Long(i64::from_be_bytes(self.array()?)),
            5 => Tag::Float(f32::from_be_bytes(self.array()?)),
            6 => Tag::Double(f64::from_be_bytes(self.array()?)),
            7 => {
                let n = self.len()?;
                Tag::ByteArray(self.take(n)?.iter().map(|&b| b as i8).collect())
            }
            8 => Tag::String(self.string()?),
            9 => {
                let item = self.u8()?;
                let n = self.len()?;
                let mut items = Vec::with_capacity(n.min(4096));
                for _ in 0..n {
                    items.push(self.payload(item, depth + 1)?);
                }
                Tag::List(item, items)
            }
            10 => {
                let mut fields = Vec::new();
                loop {
                    let field = self.u8()?;
                    if field == END {
                        break;
                    }
                    let key = self.string()?;
                    fields.push((key, self.payload(field, depth + 1)?));
                }
                Tag::Compound(fields)
            }
            11 => {
                let n = self.len()?;
                let mut v = Vec::with_capacity(n.min(4096));
                for _ in 0..n {
                    v.push(i32::from_be_bytes(self.array()?));
                }
                Tag::IntArray(v)
            }
            12 => {
                let n = self.len()?;
                let mut v = Vec::with_capacity(n.min(4096));
                for _ in 0..n {
                    v.push(i64::from_be_bytes(self.array()?));
                }
                Tag::LongArray(v)
            }
            other => bail!("type NBT inconnu : {other}"),
        })
    }
}

fn write_string(out: &mut Vec<u8>, s: &str) {
    let bytes = encode_mutf8(s);
    out.extend((bytes.len().min(u16::MAX as usize) as u16).to_be_bytes());
    out.extend(&bytes[..bytes.len().min(u16::MAX as usize)]);
}

fn write_payload(out: &mut Vec<u8>, tag: &Tag) {
    match tag {
        Tag::Byte(v) => out.push(*v as u8),
        Tag::Short(v) => out.extend(v.to_be_bytes()),
        Tag::Int(v) => out.extend(v.to_be_bytes()),
        Tag::Long(v) => out.extend(v.to_be_bytes()),
        Tag::Float(v) => out.extend(v.to_be_bytes()),
        Tag::Double(v) => out.extend(v.to_be_bytes()),
        Tag::ByteArray(v) => {
            out.extend((v.len() as i32).to_be_bytes());
            out.extend(v.iter().map(|&b| b as u8));
        }
        Tag::String(s) => write_string(out, s),
        Tag::List(item, items) => {
            out.push(if items.is_empty() && *item == 0 { END } else { *item });
            out.extend((items.len() as i32).to_be_bytes());
            for t in items {
                write_payload(out, t);
            }
        }
        Tag::Compound(fields) => {
            for (key, value) in fields {
                out.push(value.id());
                write_string(out, key);
                write_payload(out, value);
            }
            out.push(END);
        }
        Tag::IntArray(v) => {
            out.extend((v.len() as i32).to_be_bytes());
            for x in v {
                out.extend(x.to_be_bytes());
            }
        }
        Tag::LongArray(v) => {
            out.extend((v.len() as i32).to_be_bytes());
            for x in v {
                out.extend(x.to_be_bytes());
            }
        }
    }
}

/// UTF-8 modifié de Java : unités UTF-16, `\0` sur deux octets.
fn encode_mutf8(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    for unit in s.encode_utf16() {
        match unit {
            0x0001..=0x007F => out.push(unit as u8),
            0x0000 | 0x0080..=0x07FF => {
                out.push(0xC0 | (unit >> 6) as u8);
                out.push(0x80 | (unit & 0x3F) as u8);
            }
            _ => {
                out.push(0xE0 | (unit >> 12) as u8);
                out.push(0x80 | ((unit >> 6) & 0x3F) as u8);
                out.push(0x80 | (unit & 0x3F) as u8);
            }
        }
    }
    out
}

fn decode_mutf8(bytes: &[u8]) -> String {
    let mut units = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        let (unit, len) = if b < 0x80 {
            (b as u16, 1)
        } else if b & 0xE0 == 0xC0 && i + 1 < bytes.len() {
            ((((b & 0x1F) as u16) << 6) | (bytes[i + 1] & 0x3F) as u16, 2)
        } else if b & 0xF0 == 0xE0 && i + 2 < bytes.len() {
            ((((b & 0x0F) as u16) << 12) | (((bytes[i + 1] & 0x3F) as u16) << 6) | (bytes[i + 2] & 0x3F) as u16, 3)
        } else {
            (0xFFFD, 1)
        };
        units.push(unit);
        i += len;
    }
    String::from_utf16_lossy(&units)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_keeps_everything() {
        let root = Tag::Compound(vec![
            ("servers".into(), Tag::List(10, vec![Tag::Compound(vec![
                ("ip".into(), Tag::String("play.patateland.fr".into())),
                ("name".into(), Tag::String("PatateLand 🥔 é".into())),
                ("icon".into(), Tag::String("iVBORw0KGgo=".into())),
                ("acceptTextures".into(), Tag::Byte(1)),
            ])])),
            ("autre".into(), Tag::LongArray(vec![1, -2])),
            ("vide".into(), Tag::List(0, vec![])),
        ]);
        let bytes = write("", &root);
        assert_eq!(read(&bytes).unwrap(), (String::new(), root));
    }

    #[test]
    fn mutf8_matches_java() {
        // Java : "\0" -> C0 80 ; "🥔" -> paire de substitution sur 6 octets.
        assert_eq!(encode_mutf8("\0"), [0xC0, 0x80]);
        assert_eq!(encode_mutf8("🥔"), [0xED, 0xA0, 0xBE, 0xED, 0xB5, 0x94]);
        assert_eq!(decode_mutf8(&encode_mutf8("Patate 🥔\0é")), "Patate 🥔\0é");
    }

    #[test]
    fn rejects_garbage() {
        assert!(read(b"").is_err());
        assert!(read(&[10, 0, 0, 9, 0, 1, b's', 10, 0x7f, 0xff, 0xff, 0xff]).is_err());
    }
}
