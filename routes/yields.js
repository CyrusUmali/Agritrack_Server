// yieldsRoutes.js
const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/firebase-auth-middleware');
const admin = require('firebase-admin');
const pool = require('../connect');
const { area120tables } = require('googleapis/build/src/apis/area120tables');







router.get('/yields/:id', authenticate, async (req, res) => {
    try {
        const [yields] = await pool.query(
            `SELECT 
          fy.*,
          f.firstname,
          f.middlename,
          f.surname,
          f.extension,
          p.name as product_name,
          p.sector_id,
          s.sector_name
         FROM farmer_yield fy
         LEFT JOIN farmers f ON fy.farmer_id = f.id
         LEFT JOIN farm_products p ON fy.product_id = p.id
         LEFT JOIN sectors s ON p.sector_id = s.sector_id
         WHERE fy.id = ?`,
            [req.params.id]
        );

        if (yields.length === 0) {
            return res.status(404).json({ success: false, message: 'Yield not found' });
        }

        const yieldItem = yields[0];
        res.json({
            success: true,
            yield: {

                id: yieldItem.id,
                farmerId: yieldItem.farmer_id,
                farmerName: `${yieldItem.firstname}${yieldItem.middlename ? ' ' + yieldItem.middlename : ''}${yieldItem.surname ? ' ' + yieldItem.surname : ''}${yieldItem.extension ? ' ' + yieldItem.extension : ''}`,
                productId: yieldItem.product_id,
                productName: yieldItem.product_name,
                harvestDate: yieldItem.harvest_date,
                createdAt: yieldItem.created_at,
                updatedAt: yieldItem.updated_at,
                farmId: yieldItem.farm_id,
                volume: parseFloat(yieldItem.volume),
                notes: yieldItem.notes || null,
                value: yieldItem.Value ? parseFloat(yieldItem.Value) : null,
                images: yieldItem.images ? JSON.parse(yieldItem.images) : null,
                status: yieldItem.status || null,
                sectorId: yieldItem.sector_id,
                sector: yieldItem.sector_name || 'dummy'
            }
        });
    } catch (error) {
        console.error('Failed to fetch yield:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch yield' });
    }




});







router.put('/yields/:id', authenticate, async (req, res) => {
    try {
        const {
            farmer_id,
            product_id,
            harvest_date,
            farm_id,
            area_harvested,
            volume,
            notes,
            value,
            images,
            status
        } = req.body;

        // ✅ Validate area_harvested
        if (
            area_harvested === undefined ||
            area_harvested === null ||
            isNaN(area_harvested) ||
            Number(area_harvested) <= 0
        ) {
            return res.status(400).json({
                success: false,
                message: 'Invalid area_harvested value. It must be a positive number.'
            });
        }

        // Get the current yield data before update to compare changes
        const [currentYields] = await pool.query(
            `SELECT 
                fy.*,
                f.firstname,
                f.middlename,
                f.surname,
                f.extension,
                p.name as product_name
            FROM farmer_yield fy
            LEFT JOIN farmers f ON fy.farmer_id = f.id
            LEFT JOIN farm_products p ON fy.product_id = p.id
            WHERE fy.id = ?`,
            [req.params.id]
        );

        if (currentYields.length === 0) {
            return res.status(404).json({ success: false, message: 'Yield not found' });
        }

        const currentYield = currentYields[0];

        // Convert ISO date to MySQL compatible format
        const mysqlHarvestDate = harvest_date
            ? new Date(harvest_date).toISOString().slice(0, 19).replace('T', ' ')
            : null;

        // Update the yield
        await pool.query(
            `UPDATE farmer_yield 
         SET 
           farmer_id = ?, 
           product_id = ?, 
           area_harvested = ?,
           harvest_date = ?, 
           farm_id = ?, 
           volume = ?, 
           notes = ?, 
           Value = ?, 
           images = ?, 
           status = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
            [
                farmer_id,
                product_id,
                area_harvested,
                mysqlHarvestDate,
                farm_id,
                volume,
                notes,
                value,
                JSON.stringify(images),
                status,
                req.params.id
            ]
        );

        // Get the updated yield with joins
        const [yields] = await pool.query(
            `SELECT 
          fy.*,
          f.firstname,
          f.middlename,
          f.surname,
          f.extension,
          p.name as product_name,
          p.sector_id,
          s.sector_name
         FROM farmer_yield fy
         LEFT JOIN farmers f ON fy.farmer_id = f.id
         LEFT JOIN farm_products p ON fy.product_id = p.id
         LEFT JOIN sectors s ON p.sector_id = s.sector_id
         WHERE fy.id = ?`,
            [req.params.id]
        );

        if (yields.length === 0) {
            return res.status(404).json({ success: false, message: 'Yield not found after update' });
        }

        const yieldItem = yields[0];

        // Create announcement for yield update based on status transition
        try {
            const farmerName = `${currentYield.firstname}${currentYield.middlename ? ' ' + currentYield.middlename : ''}${currentYield.surname ? ' ' + currentYield.surname : ''}${currentYield.extension ? ' ' + currentYield.extension : ''}`;
            
            // Generate announcement based on status transition
            const { title, message } = generateStatusAnnouncement(
                currentYield.status, 
                status, 
                farmerName, 
                currentYield.product_name,
                currentYield.volume,
                volume,
                currentYield.area_harvested,
                area_harvested,
                notes
            );

            console.log('Announcement generation result:', { title, message, oldStatus: currentYield.status, newStatus: status });

            // Only create announcement if there's a meaningful status transition
            if (title && message) {
                // Insert announcement into database
                const [announcementResult] = await pool.query(
                    `INSERT INTO announcements (title, message, recipient_type, farmer_id, status, created_at) 
                     VALUES (?, ?, 'specific', ?, 'sent', NOW())`,
                    [title, message, farmer_id]
                );

                // Create notification for the specific farmer
                await pool.query(
                    `INSERT INTO notifications (farmer_id, announcement_id, type, status, created_at) 
                     VALUES (?, ?, 'announcement', 'unread', NOW())`,
                    [farmer_id, announcementResult.insertId]
                );

                console.log(`Announcement created for yield update: ${title}`);
            } else {
                console.log('No announcement created - no meaningful status transition');
            }

        } catch (announcementError) {
            console.error('Failed to create announcement for yield update:', announcementError);
            // Don't fail the main request if announcement creation fails
        }

        // Prepare response
        const response = {
            success: true,
            yield: {
                id: yieldItem.id,
                farmerId: yieldItem.farmer_id,
                farmerName: `${yieldItem.firstname}${yieldItem.middlename ? ' ' + yieldItem.middlename : ''}${yieldItem.surname ? ' ' + yieldItem.surname : ''}${yieldItem.extension ? ' ' + yieldItem.extension : ''}`,
                productId: yieldItem.product_id,
                productName: yieldItem.product_name,
                harvestDate: yieldItem.harvest_date,
                area_harvested: yieldItem.area_harvested,
                createdAt: yieldItem.created_at,
                updatedAt: yieldItem.updated_at,
                farmId: yieldItem.farm_id,
                volume: parseFloat(yieldItem.volume),
                notes: yieldItem.notes || null,
                value: yieldItem.Value ? parseFloat(yieldItem.Value) : null,
                images: yieldItem.images ? JSON.parse(yieldItem.images) : null,
                status: yieldItem.status || null,
                sectorId: yieldItem.sector_id,
                sector: yieldItem.sector_name || 'dummy'
            }
        };

        res.json(response);

    } catch (error) {
        console.error('Failed to update yield:', error);
        res.status(500).json({ success: false, message: 'Failed to update yield' });
    }
});

// Function to generate announcements based on status transitions
function generateStatusAnnouncement(oldStatus, newStatus, farmerName, productName, oldVolume, newVolume, oldArea, newArea, notes) {
    
    // Normalize status to lowercase for consistent comparison
    const normalizedOldStatus = (oldStatus || '').toLowerCase();
    const normalizedNewStatus = (newStatus || '').toLowerCase();
    
    console.log('Status comparison:', { normalizedOldStatus, normalizedNewStatus });

    // Only create announcements for meaningful status transitions
    if (normalizedOldStatus === normalizedNewStatus) {
        return { title: null, message: null };
    }

    // Status transition announcements
    switch (normalizedNewStatus) {
        case 'pending':
            // Only announce if moving from rejected to pending (resubmission)
            if (normalizedOldStatus === 'rejected') {
                return {
                    title: 'Harvest Resubmitted',
                    message: `Hello ${farmerName}, thank you for resubmitting your ${productName} harvest. We have received your updated information and will review it shortly.`
                };
            }
            // Don't announce initial pending status (usually created as pending)
            return { title: null, message: null };
            
        case 'accepted':
            if (normalizedOldStatus === 'pending') {
                return {
                    title: 'Harvest Accepted! ✅',
                    message: `Congratulations ${farmerName}! Your ${productName} harvest has been accepted. Your ${parseFloat(newVolume)}kg yield from ${parseFloat(newArea)} hectares has been verified and approved.`
                };
            }
            if (normalizedOldStatus === 'rejected') {
                return {
                    title: 'Harvest Now Accepted',
                    message: `Good news ${farmerName}! After review, your ${productName} harvest has been accepted. Your ${parseFloat(newVolume)}kg yield is now approved in our system.`
                };
            }
            return { title: null, message: null };
            
        case 'rejected':
            if (normalizedOldStatus === 'pending') {
                return {
                    title: 'Harvest Review Required',
                    message: `Hello ${farmerName}, we need to review your ${productName} harvest submission.Please contact our office for more information.'} You can update your harvest details and resubmit for review.`
                };
            }
            if (normalizedOldStatus === 'accepted') {
                return {
                    title: 'Harvest Status Updated',
                    message: `Hello ${farmerName}, your ${productName} harvest status has been rejected.Please contact support for assistance.'}`
                };
            }
            return { title: null, message: null };
            
        default:
            return { title: null, message: null };
    }
}




router.delete('/yields/:id', authenticate, async (req, res) => {
    try {
        // First, get the yield record to know farm_id and product_id
        const [yieldRecords] = await pool.query(
            'SELECT farm_id, product_id FROM farmer_yield WHERE id = ?',
            [req.params.id]
        );

        if (yieldRecords.length === 0) {
            return res.status(404).json({ success: false, message: 'Yield not found' });
        }

        const { farm_id, product_id } = yieldRecords[0];

        // Delete the yield record
        const [deleteResult] = await pool.query(
            'DELETE FROM farmer_yield WHERE id = ?',
            [req.params.id]
        );

        if (deleteResult.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'Yield not found' });
        }

        // Check if there are any other yield records for this product on this farm
        const [otherYields] = await pool.query(
            'SELECT COUNT(*) as count FROM farmer_yield WHERE farm_id = ? AND product_id = ?',
            [farm_id, product_id]
        );

        // If no other yields exist for this product on this farm, remove it from farm's products
        if (otherYields[0].count === 0) {
            // Get current farm products
            const [farmResult] = await pool.query(
                'SELECT products FROM farms WHERE farm_id = ?',
                [farm_id]
            );

            if (farmResult.length > 0) {
                const farm = farmResult[0];
                let farmProducts = [];

                try {
                    farmProducts = JSON.parse(farm.products || '[]');
                } catch (e) {
                    console.error('Error parsing farm products:', e);
                    // Continue with empty array on error
                }

                // Remove the product_id from farm's products if it exists
                const updatedProducts = farmProducts.filter(product => product !== product_id);

                // Update the farm record
                await pool.query(
                    'UPDATE farms SET products = ? WHERE farm_id = ?',
                    [JSON.stringify(updatedProducts), farm_id]
                );
            }
        }

        res.json({ success: true, message: 'Yield deleted successfully' });
    } catch (error) {
        console.error('Failed to delete yield:', error);
        res.status(500).json({ success: false, message: 'Failed to delete yield' });
    }
});




router.get('/yields/product/:productId', authenticate , async (req, res) => {
    const { productId } = req.params;

    try {
        const [yields] = await pool.query(`
        SELECT 
          fy.id,
          fy.farmer_id,
          fy.product_id,
          fy.harvest_date,
          fy.created_at,
          fy.updated_at,
          fy.farm_id,
          fy.volume,
          fy.notes,
          fy.Value,
          fy.images,
          fy.status,
          fy.area_harvested,
          f.barangay,
          f.firstname,
          f.middlename,
          f.surname,
          f.extension,
          p.name as product_name,
          p.sector_id,
          s.sector_name,
          farm.area as farm_area
        FROM farmer_yield fy
        LEFT JOIN farmers f ON fy.farmer_id = f.id
        LEFT JOIN farm_products p ON fy.product_id = p.id
        LEFT JOIN sectors s ON p.sector_id = s.sector_id 
        LEFT JOIN farms farm ON fy.farm_id = farm.farm_id
        WHERE fy.product_id = ?
        ORDER BY fy.harvest_date DESC
      `, [productId]);

        res.json({
            success: true,
            yields: yields.map(yieldItem => ({
                id: yieldItem.id,
                farmerId: yieldItem.farmer_id,
                farmerName: `${yieldItem.firstname}${yieldItem.middlename ? ' ' + yieldItem.middlename : ''}${yieldItem.surname ? ' ' + yieldItem.surname : ''}${yieldItem.extension ? ' ' + yieldItem.extension : ''}`,
                productId: yieldItem.product_id,
                productName: yieldItem.product_name,
                harvestDate: yieldItem.harvest_date, 
                area_harvested: yieldItem.area_harvested ? parseFloat(parseFloat(yieldItem.area_harvested)) : null, 
                createdAt: yieldItem.created_at,
                updatedAt: yieldItem.updated_at,
                farmId: yieldItem.farm_id,
                farmArea: yieldItem.farm_area ? parseFloat(yieldItem.farm_area) : null,
                volume: parseFloat(yieldItem.volume),
                notes: yieldItem.notes || null,
                value: yieldItem.Value ? parseFloat(yieldItem.Value) : null,
                images: yieldItem.images ? JSON.parse(yieldItem.images) : null,
                status: yieldItem.status || null,
                barangay: yieldItem.barangay,
                sectorId: yieldItem.sector_id,
                sector: yieldItem.sector_name || 'dummy'
            }))
        });
    } catch (error) {
        console.error('Failed to fetch yields by product ID:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch yields by product ID',
            error: {
                code: 'YIELD_FETCH_BY_PRODUCT_ERROR',
                details: error.message,
                sqlMessage: error.sqlMessage
            }
        });
    }
});





router.get('/barangay/:barangay', authenticate , async (req, res) => {
    const { barangay } = req.params;

    try {
        const [yields] = await pool.query(`
            SELECT 
                fy.id,
                fy.farmer_id,
                fy.product_id,
                fy.harvest_date,
                fy.created_at,
                fy.updated_at,
                fy.farm_id,
                fy.volume,
                fy.notes,
                fy.Value,
                fy.images,
                fy.area_harvested,
                fy.status,
                f.barangay as farmer_barangay,
                f.firstname,
                f.middlename,
                f.surname,
                f.extension,
                p.name as product_name,
                p.sector_id,
                p.imgUrl as product_imgUrl,   
                s.sector_name,
                farm.area as farm_area,
                farm.farm_name,
                farm.parentBarangay
            FROM farmer_yield fy
            LEFT JOIN farmers f ON fy.farmer_id = f.id
            LEFT JOIN farm_products p ON fy.product_id = p.id
            LEFT JOIN sectors s ON p.sector_id = s.sector_id 
            LEFT JOIN farms farm ON fy.farm_id = farm.farm_id
            WHERE farm.parentBarangay = ? AND fy.status = 'Accepted'
            ORDER BY fy.harvest_date DESC
        `, [barangay]);

        res.json({
            success: true,
            yields: yields.map(yieldItem => ({
                id: yieldItem.id,
                farmerId: yieldItem.farmer_id,
                farmerName: `${yieldItem.firstname}${yieldItem.middlename ? ' ' + yieldItem.middlename : ''}${yieldItem.surname ? ' ' + yieldItem.surname : ''}${yieldItem.extension ? ' ' + yieldItem.extension : ''}`,
                farmName: yieldItem.farm_name,
                productId: yieldItem.product_id,
                productName: yieldItem.product_name,
                productImage: yieldItem.product_imgUrl,
                harvestDate: yieldItem.harvest_date,
                createdAt: yieldItem.created_at,
                updatedAt: yieldItem.updated_at,
                farmId: yieldItem.farm_id,
                farmArea: yieldItem.farm_area ? parseFloat(yieldItem.farm_area) : null,
                volume: parseFloat(yieldItem.volume),
                notes: yieldItem.notes || null,
                value: yieldItem.Value ? parseFloat(yieldItem.Value) : null,
                images: yieldItem.images ? JSON.parse(yieldItem.images) : null,
                status: yieldItem.status || null,
                farmerBarangay: yieldItem.farmer_barangay,
                area_harvested: yieldItem.area_harvested ? parseFloat(yieldItem.area_harvested) : null,
                farmBarangay: yieldItem.parentBarangay,
                sectorId: yieldItem.sector_id,
                sector: yieldItem.sector_name || 'dummy'
            })),
            summary: {
                barangay: barangay,
                totalYields: yields.length,
                totalVolume: yields.reduce((sum, item) => sum + parseFloat(item.volume), 0),
                totalValue: yields.reduce((sum, item) => sum + (item.Value ? parseFloat(item.Value) : 0), 0)
            }
        });
    } catch (error) {
        console.error('Failed to fetch yields by barangay:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch yields by barangay',
            error: {
                code: 'YIELD_FETCH_BY_BARANGAY_ERROR',
                details: error.message,
                sqlMessage: error.sqlMessage
            }
        });
    }
}); 





router.get('/lake/:lake', authenticate ,  async (req, res) => {
    const { lake } = req.params;

    try {
        const [yields] = await pool.query(`
            SELECT 
                fy.id,
                fy.farmer_id,
                fy.product_id,
                fy.harvest_date,
                fy.created_at,
                fy.updated_at,
                fy.farm_id,
                fy.volume,
                fy.notes,
                fy.Value,
                fy.images,
                fy.area_harvested,
                fy.status,
                f.barangay as farmer_barangay,
                f.firstname,
                f.middlename,
                f.surname,
                f.extension,
                p.name as product_name,
                p.sector_id,
                p.imgUrl as product_imgUrl,   
                s.sector_name,
                farm.area as farm_area,
                farm.farm_name,
                farm.parentBarangay, 
                farm.lake
            FROM farmer_yield fy
            LEFT JOIN farmers f ON fy.farmer_id = f.id
            LEFT JOIN farm_products p ON fy.product_id = p.id
            LEFT JOIN sectors s ON p.sector_id = s.sector_id 
            LEFT JOIN farms farm ON fy.farm_id = farm.farm_id
            WHERE farm.lake = ? AND fy.status = 'Accepted'
            ORDER BY fy.harvest_date DESC
        `, [lake]);

        res.json({
            success: true,
            yields: yields.map(yieldItem => ({
                id: yieldItem.id,
                farmerId: yieldItem.farmer_id,
                farmerName: `${yieldItem.firstname}${yieldItem.middlename ? ' ' + yieldItem.middlename : ''}${yieldItem.surname ? ' ' + yieldItem.surname : ''}${yieldItem.extension ? ' ' + yieldItem.extension : ''}`,
                farmName: yieldItem.farm_name,
                productId: yieldItem.product_id,
                productName: yieldItem.product_name,
                productImage: yieldItem.product_imgUrl,
                harvestDate: yieldItem.harvest_date,
                createdAt: yieldItem.created_at,
                updatedAt: yieldItem.updated_at,
                farmId: yieldItem.farm_id,
                farmArea: yieldItem.farm_area ? parseFloat(yieldItem.farm_area) : null,
                volume: parseFloat(yieldItem.volume),
                notes: yieldItem.notes || null,
                value: yieldItem.Value ? parseFloat(yieldItem.Value) : null,
                images: yieldItem.images ? JSON.parse(yieldItem.images) : null,
                status: yieldItem.status || null,
                farmerBarangay: yieldItem.farmer_barangay,
                area_harvested: yieldItem.area_harvested ? parseFloat(yieldItem.area_harvested) : null,
                farmBarangay: yieldItem.parentBarangay,
                lake: yieldItem.lake,
                sectorId: yieldItem.sector_id,
                sector: yieldItem.sector_name || 'dummy'
            })),
            summary: {
                lake: lake,
                totalYields: yields.length,
                totalVolume: yields.reduce((sum, item) => sum + parseFloat(item.volume), 0),
                totalValue: yields.reduce((sum, item) => sum + (item.Value ? parseFloat(item.Value) : 0), 0)
            }
        });
    } catch (error) {
        console.error('Failed to fetch yields by lake:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch yields by lake',
            error: {
                code: 'YIELD_FETCH_BY_LAKE_ERROR',
                details: error.message,
                sqlMessage: error.sqlMessage
            }
        });
    }
});





router.get('/yields/farm/:farmId',authenticate ,  async (req, res) => {
    const { farmId } = req.params;

    try {
        const [yields] = await pool.query(`
        SELECT 
          fy.id,
          fy.farmer_id,
          fy.product_id,
          fy.harvest_date,
          fy.created_at,
          fy.updated_at,
          fy.area_harvested,
          fy.farm_id,
          fy.volume,
          fy.notes,
          fy.Value,
          fy.images,
          fy.status,
          f.barangay,
          f.firstname,
          f.middlename,
          f.surname,
          f.extension,
          p.name as product_name,
          p.sector_id,
          p.imgUrl as product_imgUrl,   
          s.sector_name,
          farm.area as farm_area,
          farm.farm_name
        FROM farmer_yield fy
        LEFT JOIN farmers f ON fy.farmer_id = f.id
        LEFT JOIN farm_products p ON fy.product_id = p.id
        LEFT JOIN sectors s ON p.sector_id = s.sector_id 
        LEFT JOIN farms farm ON fy.farm_id = farm.farm_id
        WHERE fy.farm_id = ? ORDER BY fy.created_at DESC 
      `, [farmId]);

        res.json({
            success: true,
            yields: yields.map(yieldItem => ({
                id: yieldItem.id,
                farmerId: yieldItem.farmer_id,
                farmerName: `${yieldItem.firstname}${yieldItem.middlename ? ' ' + yieldItem.middlename : ''}${yieldItem.surname ? ' ' + yieldItem.surname : ''}${yieldItem.extension ? ' ' + yieldItem.extension : ''}`,
                farmName: yieldItem.farm_name,
                productId: yieldItem.product_id,
                productName: yieldItem.product_name,
                productImage: yieldItem.product_imgUrl,
                harvestDate: yieldItem.harvest_date,
                
                area_harvested: yieldItem.area_harvested ? parseFloat(yieldItem.area_harvested) : null,
                createdAt: yieldItem.created_at,
                updatedAt: yieldItem.updated_at,
                farmId: yieldItem.farm_id,
                farmArea: yieldItem.farm_area ? parseFloat(yieldItem.farm_area) : null,
                volume: parseFloat(yieldItem.volume),
                notes: yieldItem.notes || null,
                value: yieldItem.Value ? parseFloat(yieldItem.Value) : null,
                images: yieldItem.images ? JSON.parse(yieldItem.images) : null,
                status: yieldItem.status || null,
                barangay: yieldItem.barangay,
                sectorId: yieldItem.sector_id,
                sector: yieldItem.sector_name || 'dummy'
            }))
        });
    } catch (error) {
        console.error('Failed to fetch yields by farm ID:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch yields by farm ID',
            error: {
                code: 'YIELD_FETCH_BY_FARM_ERROR',
                details: error.message,
                sqlMessage: error.sqlMessage
            }
        });
    }
});





router.post('/yields/generate',  async (req, res) => {
    try {
        const { farmer_id, farm_id, product_id, year, count = 20 } = req.body;

        if (!farmer_id) {
            return res.status(400).json({
                success: false,
                message: 'Farmer ID is required'
            });
        }

        // Verify the farmer exists
        const [farmers] = await pool.query('SELECT id FROM farmers WHERE id = ?', [farmer_id]);
        if (farmers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Farmer not found'
            });
        }

        // Get farms + area for this farmer
        let query = `
            SELECT f.farm_id, f.products, f.sector_id, f.area, s.sector_name 
            FROM farms f
            LEFT JOIN sectors s ON f.sector_id = s.sector_id
            WHERE f.farmer_id = ?
        `;
        const params = [farmer_id];

        if (farm_id) {
            query += ' AND f.farm_id = ?';
            params.push(farm_id);
        }

        const [farms] = await pool.query(query, params);

        if (farms.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No farms found for this farmer matching the criteria'
            });
        }

        // Get products for each sector
        const sectorProducts = {};
        const [products] = await pool.query('SELECT id, name, sector_id FROM farm_products');

        products.forEach(product => {
            if (!sectorProducts[product.sector_id]) {
                sectorProducts[product.sector_id] = [];
            }
            sectorProducts[product.sector_id].push(product);
        });

        const generatedYields = [];
        const currentYear = new Date().getFullYear();

        for (const farm of farms) {
            const availableProducts = sectorProducts[farm.sector_id] || [];
            if (availableProducts.length === 0) continue;

            let farmProducts = [];
            try {
                farmProducts = JSON.parse(farm.products || '[]');
            } catch (e) {
                console.error('Error parsing farm products:', e);
            }

            for (let i = 0; i < count; i++) {
                const randomProduct = availableProducts[Math.floor(Math.random() * availableProducts.length)];
                const selectedProductId = product_id || randomProduct.id;

                if (product_id) {
                    const productValid = availableProducts.some(p => p.id === product_id);
                    if (!productValid) {
                        console.log(`Skipping - Product ${product_id} not available for farm ${farm.farm_id}'s sector`);
                        continue;
                    }
                }

                // Ensure harvested area is > 0 and ≤ farm.area
                const maxArea = parseFloat(farm.area) || 0;
                let areaHarvested = 0;
                if (maxArea > 0) {
                    // Random between 10% and 100% of maxArea
                    const minArea = Math.max(0.1 * maxArea, 0.01); // Ensure not zero
                    areaHarvested = parseFloat((minArea + Math.random() * (maxArea - minArea)).toFixed(2));
                }

                // Generate other random data
                const harvestDate = new Date(
                    year || currentYear - Math.floor(Math.random() * 5),
                    Math.floor(Math.random() * 12),
                    Math.floor(Math.random() * 28) + 1
                ).toISOString().split('T')[0];

                const volume = (Math.random() * 1000).toFixed(2);
                const value = (volume * (5 + Math.random() * 20)).toFixed(2);
                const status = 'Accepted';
                const notes = Math.random() > 0.7 ?
                    ['Excellent harvest', 'Good quality', 'Average yield', 'Some pest damage'][Math.floor(Math.random() * 4)] :
                    null;

                // Add product to farm if missing
                if (!farmProducts.includes(selectedProductId)) {
                    farmProducts.push(selectedProductId);
                    await pool.query(
                        'UPDATE farms SET products = ? WHERE farm_id = ?',
                        [JSON.stringify(farmProducts), farm.farm_id]
                    );
                }

                // Insert yield record with area_harvested
                const [result] = await pool.query(
                    `INSERT INTO farmer_yield 
                     (farmer_id, product_id, harvest_date, farm_id, volume, notes, Value, images, status, area_harvested) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        farmer_id,
                        selectedProductId,
                        harvestDate,
                        farm.farm_id,
                        volume,
                        notes,
                        value,
                        JSON.stringify([]),
                        status,
                        areaHarvested
                    ]
                );

                // Fetch created record with joins
                const [yields] = await pool.query(
                    `SELECT 
                        fy.*,
                        f.firstname,
                        f.middlename,
                        f.surname,
                        f.extension,
                        p.name as product_name,
                        p.sector_id,
                        s.sector_name
                     FROM farmer_yield fy
                     LEFT JOIN farmers f ON fy.farmer_id = f.id
                     LEFT JOIN farm_products p ON fy.product_id = p.id
                     LEFT JOIN sectors s ON p.sector_id = s.sector_id
                     WHERE fy.id = ?`,
                    [result.insertId]
                );

                const yieldItem = yields[0];
                generatedYields.push({
                    id: yieldItem.id,
                    farmerId: yieldItem.farmer_id,
                    farmerName: `${yieldItem.firstname}${yieldItem.middlename ? ' ' + yieldItem.middlename : ''}${yieldItem.surname ? ' ' + yieldItem.surname : ''}${yieldItem.extension ? ' ' + yieldItem.extension : ''}`,
                    productId: yieldItem.product_id,
                    productName: yieldItem.product_name,
                    harvestDate: yieldItem.harvest_date,
                    farmId: yieldItem.farm_id,
                    volume: parseFloat(yieldItem.volume),
                    notes: yieldItem.notes || null,
                    value: yieldItem.Value ? parseFloat(yieldItem.Value) : null,
                    status: yieldItem.status || null,
                    sectorId: yieldItem.sector_id,
                    sector: yieldItem.sector_name,
                    areaHarvested: yieldItem.area_harvested ? parseFloat(yieldItem.area_harvested) : null
                });
            }
        }

        res.status(201).json({
            success: true,
            count: generatedYields.length,
            yields: generatedYields
        });
    } catch (error) {
        console.error('Failed to generate yields:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to generate yields',
            error: error.message
        });
    }
});




// Create a new yield record
router.post('/yields', authenticate, async (req, res) => {
    try {
        const {
            farmer_id,
            product_id,
            harvest_date,
            farm_id,
            volume,
            area_harvested,
            notes,
            value,
            images
        } = req.body;

        // Get the user's role from the authenticated request
        const userRole = req.user.dbUser.role;

        // Determine the default status based on user role
        let defaultStatus = 'Pending';
        if (userRole === 'admin' || userRole === 'Staff') {
            defaultStatus = 'Accepted';
        }

        // First, check if the farm already has this product
        const [farmResult] = await pool.query(
            'SELECT products FROM farms WHERE farm_id = ?',
            [farm_id]
        );

        if (farmResult.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Farm not found'
            });
        }

        const farm = farmResult[0];
        let farmProducts = [];

        try {
            farmProducts = JSON.parse(farm.products || '[]');
        } catch (e) {
            console.error('Error parsing farm products:', e);
        }

        // Check if product_id exists in farm's products
        if (!farmProducts.includes(product_id)) {
            // Add the product_id to the farm's products
            farmProducts.push(product_id);

            // Update the farm record
            await pool.query(
                'UPDATE farms SET products = ? WHERE farm_id = ?',
                [JSON.stringify(farmProducts), farm_id]
            );
        }

        // Proceed with creating the yield record
        const [result] = await pool.query(
            `INSERT INTO farmer_yield 
         (farmer_id, product_id, harvest_date, farm_id, volume, notes, Value, images, status ,area_harvested) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ? , ? )`,
            [
                farmer_id,
                product_id,
                harvest_date,
                farm_id,
                volume,
                notes,
                value,
                JSON.stringify(images),
                defaultStatus , // Use the determined default status 
                area_harvested
            ]
        );

        // Get the newly created yield record
        const [yields] = await pool.query(
            `SELECT 
          fy.*,
          f.firstname,
          f.middlename,
          f.surname,
          f.extension,
          p.name as product_name,
          p.sector_id,
          s.sector_name
         FROM farmer_yield fy
         LEFT JOIN farmers f ON fy.farmer_id = f.id
         LEFT JOIN farm_products p ON fy.product_id = p.id
         LEFT JOIN sectors s ON p.sector_id = s.sector_id
         WHERE fy.id = ?`,
            [result.insertId]
        );

        const yieldItem = yields[0];
        res.status(201).json({
            success: true,
            yield: {
                id: yieldItem.id,
                farmerId: yieldItem.farmer_id,
                farmerName: `${yieldItem.firstname}${yieldItem.middlename ? ' ' + yieldItem.middlename : ''}${yieldItem.surname ? ' ' + yieldItem.surname : ''}${yieldItem.extension ? ' ' + yieldItem.extension : ''}`,
                productId: yieldItem.product_id,
                productName: yieldItem.product_name,
                harvestDate: yieldItem.harvest_date,
                area_harvested: yieldItem.area_harvested,
                createdAt: yieldItem.created_at,
                updatedAt: yieldItem.updated_at,
                farmId: yieldItem.farm_id,
                volume: parseFloat(yieldItem.volume),
                notes: yieldItem.notes || null,
                value: yieldItem.Value ? parseFloat(yieldItem.Value) : null,
                images: yieldItem.images ? JSON.parse(yieldItem.images) : null,
                status: yieldItem.status,
                sectorId: yieldItem.sector_id,
                sector: yieldItem.sector_name || 'dummy'
            }
        });
    } catch (error) {
        console.error('Failed to create yield:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create yield',
            error: error.message
        });
    }
});



router.get('/farmer-yield-distribution',authenticate , async (req, res) => {
  try {
    const { farmerId, year } = req.query;

    // Validate required parameters
    if (!farmerId) {
      return res.status(400).json({
        success: false,
        message: 'Farmer ID is required'
      });
    }

    if (isNaN(farmerId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid farmer ID provided'
      });
    }

    // Validate year if provided
    if (year && (isNaN(year) || year.length !== 4)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid year provided (must be 4 digits)'
      });
    }

    // Build the query
    let query = `
      SELECT 
        p.id as product_id,
        p.name as product_name,
        s.sector_id,
        s.sector_name,
        COUNT(fy.id) as yield_count,
        SUM(fy.volume) as total_volume,
        SUM(fy.Value) as total_value,
        AVG(fy.volume) as avg_volume,
        AVG(fy.Value) as avg_value,
        MIN(fy.harvest_date) as first_harvest,
        MAX(fy.harvest_date) as last_harvest
      FROM farmer_yield fy
      JOIN farm_products p ON fy.product_id = p.id
      JOIN sectors s ON p.sector_id = s.sector_id
      WHERE fy.farmer_id = ?
    `;

    const params = [farmerId];

    // Add year filter if provided
    if (year) {
      query += ' AND YEAR(fy.harvest_date) = ?';
      params.push(year);
    }

    // Complete the query
    query += `
      GROUP BY p.id
      ORDER BY total_volume DESC
    `;

    const [productDistribution] = await pool.query(query, params);

    // Calculate grand totals
    const grandTotal = {
      yieldCount: 0,
      totalVolume: 0,
      totalValue: 0
    };

    // Process each product
    const products = productDistribution.map(row => {
      const product = {
        productId: row.product_id,
        productName: row.product_name,
        sectorId: row.sector_id,
        sectorName: row.sector_name,
        yieldCount: parseInt(row.yield_count),
        totalVolume: parseFloat(row.total_volume),
        totalValue: parseFloat(row.total_value),
        avgVolume: parseFloat(row.avg_volume),
        avgValue: parseFloat(row.avg_value),
        firstHarvest: row.first_harvest,
        lastHarvest: row.last_harvest,
        percentageOfVolume: 0,
        percentageOfValue: 0
      };

      // Update grand totals
      grandTotal.yieldCount += product.yieldCount;
      grandTotal.totalVolume += product.totalVolume;
      grandTotal.totalValue += product.totalValue;

      return product;
    });

    // Calculate percentages if there are results
    if (productDistribution.length > 0) {
      products.forEach(product => {
        product.percentageOfVolume = grandTotal.totalVolume > 0 ?
          Math.round((product.totalVolume / grandTotal.totalVolume) * 100 * 100) / 100 : 0;
        product.percentageOfValue = grandTotal.totalValue > 0 ?
          Math.round((product.totalValue / grandTotal.totalValue) * 100 * 100) / 100 : 0;
      });
    }

    res.json({
      success: true,
      data: {
        farmerId: farmerId,
        yearFilter: year || 'all years',
        grandTotal: grandTotal,
        products: products
      }
    });

  } catch (error) {
    console.error('Failed to fetch farmer product distribution:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch farmer product distribution',
      error: {
        code: 'FARMER_PRODUCT_DISTRIBUTION_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});







router.get('/yields/:farmId',    async (req, res) => {
    try {
        const { farmId } = req.params;

        // First, verify the farm exists
        const [farmCheck] = await pool.query(
            'SELECT farm_id FROM farms WHERE farm_id = ?',
            [farmId]
        );

        if (farmCheck.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Farm not found'
            });
        }

        // Get yields for the specific farm
        const [yields] = await pool.query(`
        SELECT 
          fy.id,
          fy.farmer_id,
          fy.product_id,
          fy.harvest_date,
          fy.created_at,
          fy.updated_at,
          fy.farm_id,
          fy.volume,
          fy.notes,
          fy.Value,
          fy.images,
          fy.status,
          f.firstname,
          f.middlename,
          f.surname,
          f.extension,
          p.name as product_name,
          p.sector_id,
          s.sector_name,
          farm.farm_name,
          farm.area as farm_area
        FROM farmer_yield fy
        LEFT JOIN farmers f ON fy.farmer_id = f.id
        LEFT JOIN farm_products p ON fy.product_id = p.id
        LEFT JOIN sectors s ON p.sector_id = s.sector_id 
        LEFT JOIN farms farm ON fy.farm_id = farm.farm_id
        WHERE fy.farm_id = ?
        ORDER BY fy.created_at DESC
      `, [farmId]);

        res.json({
            success: true,
            yields: yields.map(yieldItem => ({
                id: yieldItem.id,
                farmerId: yieldItem.farmer_id,
                farmerName: `${yieldItem.firstname}${yieldItem.middlename ? ' ' + yieldItem.middlename : ''}${yieldItem.surname ? ' ' + yieldItem.surname : ''}${yieldItem.extension ? ' ' + yieldItem.extension : ''}`,
                productId: yieldItem.product_id,
                productName: yieldItem.product_name,
                harvestDate: yieldItem.harvest_date,
                createdAt: yieldItem.created_at,
                updatedAt: yieldItem.updated_at,
                farmId: yieldItem.farm_id,
                farmName: yieldItem.farm_name,
                farmArea: yieldItem.farm_area ? parseFloat(yieldItem.farm_area) : null,
                volume: parseFloat(yieldItem.volume),
                notes: yieldItem.notes || null,
                value: yieldItem.Value ? parseFloat(yieldItem.Value) : null,
                images: yieldItem.images ? JSON.parse(yieldItem.images) : null,
                status: yieldItem.status || null,
                sectorId: yieldItem.sector_id,
                sector: yieldItem.sector_name || 'dummy'
            }))
        });

    } catch (error) {
        console.error('Failed to fetch farm yields:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch yields for this farm',
            error: {
                code: 'FARM_YIELD_FETCH_ERROR',
                details: error.message,
                sqlMessage: error.sqlMessage
            }
        });
    }
});

router.get('/farmer-yields/:farmerId?',authenticate ,  async (req, res) => {
    try {
        const { farmerId } = req.params;

        let query = `
        SELECT 
          fy.id,
          fy.farmer_id,
          fy.product_id,
          fy.harvest_date,
          fy.created_at,
          fy.updated_at,
          fy.farm_id,
          fy.area_harvested,
          fy.volume,
          fy.notes,
          fy.Value,
          fy.images,
          fy.status,
          f.barangay,
          f.firstname,
          f.middlename,
          f.surname,
          f.extension,
          p.name as product_name,
           p.imgUrl as productImage,
          p.sector_id,
          s.sector_name,
          farm.area as farm_area,
          farm.farm_name
        FROM farmer_yield fy
        LEFT JOIN farmers f ON fy.farmer_id = f.id
        LEFT JOIN farm_products p ON fy.product_id = p.id
        LEFT JOIN sectors s ON p.sector_id = s.sector_id 
        LEFT JOIN farms farm ON fy.farm_id = farm.farm_id
      `;

        // Add WHERE clause if farmerId is provided
        if (farmerId) {
            query += ` WHERE fy.farmer_id = ? `;
        }
          
        // Changed from harvest_date to created_at for sorting
        query += ` ORDER BY fy.created_at DESC`;
        // Execute query with or without farmerId parameter
        const [yields] = farmerId
            ? await pool.query(query, [farmerId])
            : await pool.query(query);

        res.json({
            success: true,
            yields: yields.map(yieldItem => ({ 
                id: yieldItem.id,
                farmerId: yieldItem.farmer_id,
                farmerName: `${yieldItem.firstname}${yieldItem.middlename ? ' ' + yieldItem.middlename : ''}${yieldItem.surname ? ' ' + yieldItem.surname : ''}${yieldItem.extension ? ' ' + yieldItem.extension : ''}`,
                productId: yieldItem.product_id,
                productImage: yieldItem.productImage,
                productName: yieldItem.product_name,
                harvestDate: yieldItem.harvest_date,
                createdAt: yieldItem.created_at,
                updatedAt: yieldItem.updated_at,
                farmId: yieldItem.farm_id,
                farmName: yieldItem.farm_name,
                area_harvested: yieldItem.area_harvested,
                farmArea: yieldItem.farm_area ? parseFloat(yieldItem.farm_area) : null,
                volume: parseFloat(yieldItem.volume),
                notes: yieldItem.notes || null,
                value: yieldItem.Value ? parseFloat(yieldItem.Value) : null,
                images: yieldItem.images ? JSON.parse(yieldItem.images) : null,
                status: yieldItem.status || null,
                barangay: yieldItem.barangay,
                sectorId: yieldItem.sector_id, 
                sector: yieldItem.sector_name || 'dummy'
            }))
        });
    } catch (error) {
        console.error('Failed to fetch yields:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch yields',
            error: {
                code: 'YIELD_FETCH_ERROR',
                details: error.message,
                sqlMessage: error.sqlMessage
            }
        });
    }
});

router.get('/yield-distribution', authenticate , async (req, res) => {
    try {
        const { sectorId, year } = req.query;

        // Build the base query
        let query = `
        SELECT 
          s.sector_id,
          s.sector_name,
          p.id as product_id,
          p.name as product_name,
          COUNT(fy.id) as yield_count,
          SUM(fy.volume) as total_volume,
          SUM(fy.Value) as total_value,
          AVG(fy.volume) as avg_volume,
          AVG(fy.Value) as avg_value
        FROM farmer_yield fy
        JOIN farm_products p ON fy.product_id = p.id
        JOIN sectors s ON p.sector_id = s.sector_id
      `;

        const params = [];
        const conditions = [];

        // Add sector filter if provided
        if (sectorId) {
            if (isNaN(sectorId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid sector ID provided'
                });
            }
            conditions.push('s.sector_id = ?');
            params.push(sectorId);
        }

        // Add year filter if provided
        if (year) {
            if (isNaN(year) || year.length !== 4) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid year provided (must be 4 digits)'
                });
            }
            conditions.push('YEAR(fy.harvest_date) = ?');
            params.push(year);
        }

        // Add WHERE clause if there are conditions
        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        // Complete the query
        query += `
        GROUP BY s.sector_id, p.id
        ORDER BY s.sector_name, p.name
      `;

        const [yieldDistribution] = await pool.query(query, params);

        // Organize the data by sector
        const distributionBySector = {};

        yieldDistribution.forEach(row => {
            const sectorId = row.sector_id;

            if (!distributionBySector[sectorId]) {
                distributionBySector[sectorId] = {
                    sectorId: sectorId,
                    sectorName: row.sector_name,
                    totalYields: 0,
                    totalVolume: 0,
                    totalValue: 0,
                    products: []
                };
            }

            const productData = {
                productId: row.product_id,
                productName: row.product_name,
                yieldCount: parseInt(row.yield_count),
                totalVolume: parseFloat(row.total_volume),
                totalValue: parseFloat(row.total_value),
                avgVolume: parseFloat(row.avg_volume),
                avgValue: parseFloat(row.avg_value),
                percentageOfSectorVolume: 0,
                percentageOfSectorValue: 0
            };

            distributionBySector[sectorId].products.push(productData);
            distributionBySector[sectorId].totalYields += productData.yieldCount;
            distributionBySector[sectorId].totalVolume += productData.totalVolume;
            distributionBySector[sectorId].totalValue += productData.totalValue;
        });

        // Calculate percentages for each product within its sector
        // Calculate percentages for each product within its sector
        Object.values(distributionBySector).forEach(sector => {
            sector.products.forEach(product => {
                product.percentageOfSectorVolume = sector.totalVolume > 0 ?
                    Math.round((product.totalVolume / sector.totalVolume) * 100 * 100) / 100 : 0; // Round to 2 decimal places
                product.percentageOfSectorValue = sector.totalValue > 0 ?
                    Math.round((product.totalValue / sector.totalValue) * 100 * 100) / 100 : 0; // Round to 2 decimal places
            });

            // Sort products by volume (descending)
            sector.products.sort((a, b) => b.totalVolume - a.totalVolume);
        });

        // Convert to array and sort by sector name
        const result = Object.values(distributionBySector).sort((a, b) =>
            a.sectorName.localeCompare(b.sectorName)
        );

        res.json({
            success: true,
            data: result,
            ...(sectorId && { sectorFilter: sectorId }),
            ...(year && { yearFilter: year })
        });

    } catch (error) {
        console.error('Failed to fetch yield distribution:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch yield distribution',
            error: {
                code: 'YIELD_DISTRIBUTION_ERROR',
                details: error.message,
                sqlMessage: error.sqlMessage
            }
        });
    }
});









router.get('/yield-statistics', authenticate ,  async (req, res) => {
    try {
      const { year, farmerId } = req.query;
  
      // Improved addFilters function with status filter
      const addFilters = (baseQuery, options = {}) => {
        let query = baseQuery.trim();
        const params = [];
        const conditions = [];
  
        // Always include status = 'Accepted' condition
        conditions.push(`fy.status = 'Accepted'`);
  
        if (year) {
          conditions.push(`YEAR(${options.dateField || 'fy.harvest_date'}) = ?`);
          params.push(year);
        }
  
        if (farmerId) {
          conditions.push(`fy.farmer_id = ?`);
          params.push(farmerId);
        }
  
        if (conditions.length > 0) {
          const lowerQuery = query.toLowerCase();
  
          if (lowerQuery.includes('where')) {
            // Just append the conditions with AND
            query = query.replace(/(where\s+1\s*=\s*1)/i, `$1 AND ${conditions.join(' AND ')}`);
            if (!/where\s+1\s*=\s*1/i.test(query)) {
              query = query.replace(/(where\s+)/i, `$1${conditions.join(' AND ')} AND `);
            }
          } else {
            // Insert WHERE before GROUP BY / ORDER BY / LIMIT if needed
            const clauses = ['GROUP BY', 'ORDER BY', 'LIMIT'];
            let insertPos = query.length;
  
            for (const clause of clauses) {
              const idx = query.toUpperCase().indexOf(clause);
              if (idx >= 0 && idx < insertPos) {
                insertPos = idx;
              }
            }
  
            query = `${query.slice(0, insertPos)} WHERE ${conditions.join(' AND ')} ${query.slice(insertPos)}`;
          }
        }
  
        return { query, params };
      };
  
      // Rest of your queries remain the same...
      // 1. Total yield
      const totalYieldQuery = addFilters(`
        SELECT SUM(fy.volume) as totalYield 
        FROM farmer_yield fy
        JOIN farm_products p ON fy.product_id = p.id
      `);
      const [totalYieldResult] = await pool.query(totalYieldQuery.query, totalYieldQuery.params);
  
      // 2. Average yield per hectare
      const avgYieldQuery = addFilters(`
        SELECT 
          IFNULL(ROUND(SUM(fy.volume) / NULLIF(SUM(farm.area), 0), 2), 0) as avgYieldPerHectare
        FROM farmer_yield fy
        JOIN farms farm ON fy.farm_id = farm.farm_id
        JOIN farm_products p ON fy.product_id = p.id
      `);
      const [avgYieldResult] = await pool.query(avgYieldQuery.query, avgYieldQuery.params);
  
      // 3. Top crop yield - using WHERE 1=1 for simpler condition addition
      const topCropQuery = addFilters(`
        SELECT 
          p.name as productName,
          SUM(fy.volume) as totalVolume
        FROM farmer_yield fy
        JOIN farm_products p ON fy.product_id = p.id
        WHERE 1=1
        GROUP BY p.name
        ORDER BY totalVolume DESC
        LIMIT 1
      `);
      const [topCropResult] = await pool.query(topCropQuery.query, topCropQuery.params);
  
      // 4. This month's yield
      const currentYear = new Date().getFullYear().toString();
      const isCurrentYear = year === currentYear || !year;
  
      const thisMonthQuery = addFilters(`
        SELECT SUM(fy.volume) as thisMonthYield
        FROM farmer_yield fy
        JOIN farm_products p ON fy.product_id = p.id
        ${isCurrentYear ? `WHERE fy.harvest_date >= DATE_FORMAT(NOW(), '%Y-%m-01')` : ''}
      `);
      const [thisMonthResult] = await pool.query(thisMonthQuery.query, thisMonthQuery.params);
  
      // Format response
      res.json({
        success: true,
        statistics: {
          totalYield: totalYieldResult[0]?.totalYield || 0,
          averageYieldPerHectare: avgYieldResult[0]?.avgYieldPerHectare ?
            `${avgYieldResult[0].avgYieldPerHectare} t/ha` : '0 t/ha',
          topCrop: topCropResult[0] ? {
            product: topCropResult[0].productName,
            volume: topCropResult[0].totalVolume
          } : null,
          thisMonthYield: thisMonthResult[0]?.thisMonthYield || 0,
          year: year || 'all-time',
          farmer: farmerId || 'all-farmers'
        }
      });
  
    } catch (error) {
      console.error('Failed to fetch yield statistics:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch yield statistics',
        error: {
          code: 'YIELD_STATS_ERROR',
          details: error.message,
          sqlMessage: error.sqlMessage || 'No SQL error'
        }
      });
    }
  });
  
  
  


module.exports = router;
