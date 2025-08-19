// yieldsRoutes.js
const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/firebase-auth-middleware');
const admin = require('firebase-admin');
const pool = require('../connect');

 
 

 
router.delete('/products/:id', authenticate, async (req, res) => {
  try {
    const productId = req.params.id;
    const userId = req.user.dbUser.id;
    const userSectorId = req.user.dbUser.sector_id;

    // First verify the product exists and belongs to the user's sector
    const [productCheck] = await pool.query(
      `SELECT p.id 
       FROM farm_products p
       WHERE p.id = ? 
       ${userSectorId ? 'AND p.sector_id = ?' : ''}`,
      userSectorId ? [productId, userSectorId] : [productId]
    );

    if (productCheck.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found or not authorized',
        error: {
          code: 'PRODUCT_NOT_FOUND',
          details: `Product with ID ${productId} not found in your sector`
        }
      });
    }

    // Delete the product
    await pool.query(
      'DELETE FROM farm_products WHERE id = ?',
      [productId]
    );

    res.json({
      success: true,
      message: 'Product deleted successfully',
      deletedId: productId
    });

  } catch (error) {
    console.error('Failed to delete product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete product',
      error: {
        code: 'PRODUCT_DELETION_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});





router.post('/products', authenticate, async (req, res) => {
  try {
    const { name, description, sector_id, imageUrl } = req.body;
    const userId = req.user.dbUser.id; // Assuming you want to track who created the product

    // Validate required fields
    if (!name || !description || !sector_id) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
        required: ['name', 'description', 'sector_id']
      });
    }

    // Check if sector exists
    const [sectorCheck] = await pool.query(
      'SELECT sector_id FROM sectors WHERE sector_id = ?',
      [sector_id]
    );

    if (sectorCheck.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid sector_id',
        error: {
          code: 'INVALID_SECTOR',
          details: `Sector with ID ${sector_id} not found`
        }
      });
    }

    // Insert new product including optional imageUrl
    const [result] = await pool.query(
      `INSERT INTO farm_products 
   (name, description, sector_id, imgUrl, created_at, updated_at) 
   VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [name, description, sector_id, imageUrl || null]
    );

    // Get the newly created product with sector name
    const [newProduct] = await pool.query(
      `SELECT 
        p.id,
        p.name,
        p.description,
        p.imgUrl,
        p.created_at,
        p.updated_at,
        s.sector_name
      FROM farm_products p
      JOIN sectors s ON p.sector_id = s.sector_id
      WHERE p.id = ?`,
      [result.insertId]
    );

    if (newProduct.length === 0) {
      throw new Error('Failed to retrieve created product');
    }

    res.status(201).json({
      success: true,
      product: {
        id: newProduct[0].id,
        name: newProduct[0].name,
        description: newProduct[0].description,
        sector: newProduct[0].sector_name,
        imageUrl: newProduct[0].imgUrl,
        createdAt: newProduct[0].created_at,
        updatedAt: newProduct[0].updated_at
      }
    });

  } catch (error) {
    console.error('Failed to add product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add product',
      error: {
        code: 'PRODUCT_CREATION_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});


router.put('/products/:id', authenticate, async (req, res) => {
  try {
    const productId = req.params.id;
    const { name, description, sector_id, imageUrl } = req.body;
    const userId = req.user.dbUser.id; // Available if you want to track who modified the product

    // Validate required fields
    if (!name || !description || !sector_id) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields',
        required: ['name', 'description', 'sector_id']
      });
    }

    // Check if product exists
    const [productCheck] = await pool.query(
      'SELECT id FROM farm_products WHERE id = ?',
      [productId]
    );

    if (productCheck.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
        error: {
          code: 'PRODUCT_NOT_FOUND',
          details: `Product with ID ${productId} not found`
        }
      });
    }

    // Check if sector exists
    const [sectorCheck] = await pool.query(
      'SELECT sector_id FROM sectors WHERE sector_id = ?',
      [sector_id]
    );

    if (sectorCheck.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid sector_id',
        error: {
          code: 'INVALID_SECTOR',
          details: `Sector with ID ${sector_id} not found`
        }
      });
    }

    // Update the product
    await pool.query(
      `UPDATE farm_products 
       SET 
         name = ?, 
         description = ?, 
         sector_id = ?, 
         imgUrl = ?, 
         updated_at = NOW()
       WHERE id = ?`,
      [name, description, sector_id, imageUrl || null, productId]
    );

    // Get the updated product with sector name
    const [updatedProduct] = await pool.query(
      `SELECT 
        p.id,
        p.name,
        p.description,
        p.imgUrl,
        p.created_at,
        p.updated_at,
        s.sector_name
      FROM farm_products p
      JOIN sectors s ON p.sector_id = s.sector_id
      WHERE p.id = ?`,
      [productId]
    );

    if (updatedProduct.length === 0) {
      throw new Error('Failed to retrieve updated product');
    }

    res.status(200).json({
      success: true,
      product: {
        id: updatedProduct[0].id,
        name: updatedProduct[0].name,
        description: updatedProduct[0].description,
        sector: updatedProduct[0].sector_name,
        imageUrl: updatedProduct[0].imgUrl,
        createdAt: updatedProduct[0].created_at,
        updatedAt: updatedProduct[0].updated_at
      }
    });

  } catch (error) {
    console.error('Failed to update product:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update product',
      error: {
        code: 'PRODUCT_UPDATE_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});



 

router.get('/products', authenticate, async (req, res) => {
  try {

    let query = `
     SELECT 
  p.id,
  p.name,
  p.description,
  p.imgUrl,
  p.created_at,
  p.updated_at,
  s.sector_name
FROM farm_products p
JOIN sectors s ON p.sector_id = s.sector_id 
    `;

    const params = [];



    query += ' ORDER BY  p.name';

    const [products] = await pool.query(query, params);

    res.json({
      success: true,
      products: products.map(product => ({
        id: product.id,
        name: product.name,
        description: product.description,
        sector: product.sector_name,
        imageUrl: product.imgUrl, // Make sure this column is correctly named in the DB
        createdAt: product.created_at,
        updatedAt: product.updated_at
      }))
    });

  } catch (error) {
    console.error('Failed to fetch products:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch products',
      error: {
        code: 'PRODUCT_FETCH_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});




module.exports = router;