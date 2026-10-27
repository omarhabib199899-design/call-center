const router = require("express").Router();
const { query } = require("../database/dbpromise.js");
const randomstring = require("randomstring");
const bcrypt = require("bcrypt");
const {
  isValidEmail,
  areMobileNumbersFilled,
} = require("../functions/function.js");
const { sign } = require("jsonwebtoken");
const validateUser = require("../middlewares/user.js");
const csv = require("csv-parser");
const fs = require("fs");
const { checkPlan, checkContactLimit } = require("../middlewares/plan.js");
const logger = require("../utils/logger.js");

// add phonebook name
router.post(
  "/add",
  validateUser,
  checkPlan,
  checkContactLimit,
  async (req, res) => {
    try {
      const { name } = req.body;

      if (!name) {
        return res.json({
          success: false,
          msg: "Please enter a phonebook name",
        });
      }

      // find ext
      const findExt = await query(
        `SELECT * FROM phonebook WHERE uid = ? AND name = ?`,
        [req.decode.uid, name],
      );

      if (findExt.length > 0) {
        return res.json({
          success: false,
          msg: "Duplicate phonebook name found",
        });
      }

      await query(`INSERT INTO phonebook (name, uid) VALUES (?,?)`, [
        name,
        req.decode.uid,
      ]);
      res.json({ success: true, msg: "Phonebook was addedd" });
    } catch (err) {
      res.json({ success: false, msg: "something went wrong" });
      logger.log(err);
    }
  },
);

// get by uid
router.get("/get_by_uid", validateUser, async (req, res) => {
  try {
    let data = await query(`SELECT * FROM phonebook WHERE uid = ?`, [
      req.decode.uid,
    ]);

    data = await Promise.all(
      data.map(async (x) => {
        const [result] = await query(
          `SELECT COUNT(*) AS count FROM contact WHERE phonebook_id = ?`,
          [x.id],
        );
        return { ...x, contactCount: result.count };
      }),
    );

    res.json({ data, success: true });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

// Edit Contact
router.put("/edit_contact", validateUser, async (req, res) => {
  const { contactId, name, mobile, var1, var2, var3, var4, var5 } = req.body;

  try {
    // Update contact in the database
    const result = await query(
      `UPDATE contact SET name = ?, mobile = ?, var1 = ?, var2 = ?, var3 = ?, var4 = ?, var5 = ?, var6 = ? WHERE id = ? AND uid = ?`,
      [
        name,
        mobile,
        var1,
        var2,
        var3,
        var4,
        var5,
        var6,
        contactId,
        req.decode.uid,
      ],
    );

    if (result.affectedRows > 0) {
      res.json({ success: true, msg: "Contact updated successfully" });
    } else {
      res.json({ success: false, msg: "Contact not found or no changes made" });
    }
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

// del a phonebook
router.post("/del_phonebook", validateUser, async (req, res) => {
  try {
    const { id } = req.body;

    await query(`DELETE FROM phonebook WHERE id = ?`, [id]);
    await query(`DELETE FROM contact WHERE phonebook_id = ? AND uid = ?`, [
      id,
      req.decode.uid,
    ]);

    res.json({ success: true, msg: "Phonebook was deleted" });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong" });
    logger.log(err);
  }
});

function parseCSVFile(fileData) {
  return new Promise((resolve, reject) => {
    const results = [];

    // Check if file data is provided
    if (!fileData) {
      resolve(null);
      return;
    }

    const stream = require("stream");
    const bufferStream = new stream.PassThrough();

    // Convert file data (Buffer) to a readable stream
    bufferStream.end(fileData);

    // Use csv-parser to parse the CSV data
    bufferStream
      .pipe(csv())
      .on("data", (data) => {
        // Push each row of data to the results array
        results.push(data);
      })
      .on("end", () => {
        // Resolve the promise with the parsed CSV data
        resolve(results);
      })
      .on("error", (error) => {
        // Reject the promise if there is an error
        resolve(null);
      });
  });
}

function validateMobile(mobile) {
  if (!mobile) return false;

  const cleaned = String(mobile).trim();

  // Only digits allowed
  return /^\d+$/.test(cleaned);
}

router.post(
  "/import_contacts",
  validateUser,
  checkPlan,
  checkContactLimit,
  async (req, res) => {
    try {
      if (!req.files || Object.keys(req.files).length === 0) {
        return res.json({
          success: false,
          msg: "No files were uploaded",
        });
      }

      const { id, phonebook_name } = req.body;

      const csvData = await parseCSVFile(req.files.file.data);

      if (!csvData) {
        return res.json({
          success: false,
          msg: "Invalid CSV provided",
        });
      }

      const cvalidateMobile = areMobileNumbersFilled(csvData);

      if (!cvalidateMobile) {
        return res.json({
          success: false,
          msg: "Please check your CSV. One or more mobile numbers are empty.",
        });
      }

      const invalidNumbers = [];

      csvData.forEach((row, index) => {
        const mobile = String(row.mobile || "").trim();

        if (!validateMobile(mobile)) {
          invalidNumbers.push({
            row: index + 2,
            name: row.name || "",
            mobile,
          });
        }
      });

      if (invalidNumbers.length > 0) {
        return res.json({
          success: false,
          msg: `${invalidNumbers.length} invalid phone numbers found. Only digits are allowed.`,
          invalidNumbers,
        });
      }

      const values = csvData.map((item) => [
        req.decode.uid,
        id,
        phonebook_name,
        item.name,
        String(item.mobile).trim(),
        item.var1,
        item.var2,
        item.var3,
        item.var4,
        item.var5,
      ]);

      await query(
        `INSERT INTO contact (uid, phonebook_id, phonebook_name, name, mobile, var1, var2, var3, var4, var5) VALUES ?`,
        [values],
      );

      res.json({
        success: true,
        msg: "Contacts were inserted",
        inserted: values.length,
      });
    } catch (err) {
      logger.log(err);

      res.json({
        success: false,
        msg: "Something went wrong",
      });
    }
  },
);

router.post(
  "/add_single_contact",
  validateUser,
  checkPlan,
  checkContactLimit,
  async (req, res) => {
    try {
      const { id, phonebook_name, mobile, name, var1, var2, var3, var4, var5 } =
        req.body;

      if (!mobile) {
        return res.json({
          success: false,
          msg: "Mobile number is required",
        });
      }

      const cleanedMobile = String(mobile).trim();

      if (!validateMobile(cleanedMobile)) {
        return res.json({
          success: false,
          msg: `Invalid mobile number "${mobile}". Only digits are allowed (0-9).`,
        });
      }

      await query(
        `INSERT INTO contact (uid, phonebook_id, phonebook_name, name, mobile, var1, var2, var3, var4, var5) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [
          req.decode.uid,
          id,
          phonebook_name,
          name,
          cleanedMobile,
          var1,
          var2,
          var3,
          var4,
          var5,
        ],
      );

      res.json({
        success: true,
        msg: "Contact was inserted",
      });
    } catch (err) {
      logger.log(err);

      res.json({
        success: false,
        msg: "Something went wrong",
      });
    }
  },
);

// GET /api/phonebook/get_uid_contacts?page=1&limit=50&search=john&phonebook_id=
router.get("/get_uid_contacts", validateUser, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;
    const search = (req.query.search || "").trim();
    const phonebook_id = req.query.phonebook_id || "";

    let whereClauses = ["uid = ?"];
    let params = [req.decode.uid];

    if (search) {
      whereClauses.push("(name LIKE ? OR mobile LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }

    if (phonebook_id) {
      whereClauses.push("phonebook_id = ?");
      params.push(phonebook_id);
    }

    const whereSQL = "WHERE " + whereClauses.join(" AND ");

    const [countResult] = await query(
      `SELECT COUNT(*) AS total FROM contact ${whereSQL}`,
      params,
    );

    const data = await query(
      `SELECT * FROM contact ${whereSQL} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    res.json({
      success: true,
      data,
      pagination: {
        total: countResult.total,
        page,
        limit,
        totalPages: Math.ceil(countResult.total / limit),
      },
    });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

// dele contcats
router.post("/del_contacts", validateUser, async (req, res) => {
  try {
    await query(`DELETE FROM contact WHERE id IN (?)`, [req.body.selected]);
    res.json({ success: true, msg: "Contact(s) was deleted" });
  } catch (err) {
    res.json({ success: false, msg: "something went wrong" });
    logger.log(err);
  }
});

// In phonebook.js router — just a simple read, no new logic
router.get("/get_for_flow", validateUser, async (req, res) => {
  try {
    const data = await query(
      `SELECT id, name FROM phonebook WHERE uid = ? ORDER BY name ASC`,
      [req.decode.uid],
    );
    res.json({ success: true, data });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

// GET /api/phonebook/export_contacts_csv?search=&phonebook_id=
router.get("/export_contacts_csv", validateUser, async (req, res) => {
  try {
    const search = (req.query.search || "").trim();
    const phonebook_id = req.query.phonebook_id || "";

    let whereClauses = ["uid = ?"];
    let params = [req.decode.uid];

    if (search) {
      whereClauses.push("(name LIKE ? OR mobile LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }

    if (phonebook_id) {
      whereClauses.push("phonebook_id = ?");
      params.push(phonebook_id);
    }

    const whereSQL = "WHERE " + whereClauses.join(" AND ");

    const data = await query(
      `SELECT name, mobile, phonebook_name, var1, var2, var3, var4, var5, createdAt
       FROM contact ${whereSQL} ORDER BY id DESC`,
      params,
    );

    const fields = [
      "name",
      "mobile",
      "phonebook_name",
      "var1",
      "var2",
      "var3",
      "var4",
      "var5",
      "createdAt",
    ];
    const header = fields.join(",");
    const rows = data.map((row) =>
      fields
        .map((f) => `"${(row[f] ?? "").toString().replace(/"/g, '""')}"`)
        .join(","),
    );

    const csv = [header, ...rows].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="contacts_export_${Date.now()}.csv"`,
    );
    res.send(csv);
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

module.exports = router;
