// yieldsRoutes.js
const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/firebase-auth-middleware');
const admin = require('firebase-admin');
const pool = require('../connect');


router.get('/barangay-yields-report', async (req, res) => {
    try {
        // Extract and clean the IDs
        const barangayName = req.query.barangayName ? req.query.barangayName.trim() : null;
        const productId = req.query.productId ? req.query.productId.split(':')[0].trim() : null;
        const sectorId = req.query.sectorId ? req.query.sectorId.split(':')[0].trim() : null;

        // Other params
        const { startDate, endDate, viewBy } = req.query;

        const countParam = req.query.count ? req.query.count.trim().toLowerCase() : 'all';
        
        // Parse count parameter
        const count = countParam === 'all' ? null : parseInt(countParam);
        const limitCount = Number.isInteger(count) && count > 0 ? count : null;

        // Validate date range
        const dateRangeValid = startDate && endDate && startDate !== endDate;

        let query;
        let groupBy = '';
        let selectFields = `
            b.name as barangay_name,
            fy.product_id,
            p.name as product_name,
            NULL as harvest_date,
            NULL as volume,
            NULL as Value,
            NULL as harvest_year,
            NULL as harvest_month
        `;

        if (viewBy === 'Monthly') {
            selectFields = `
                b.name as barangay_name,
                ${productId ? 'fy.product_id' : 'NULL as product_id'},
                ${productId ? 'p.name as product_name' : 'NULL as product_name'},
                NULL as harvest_date,
                COALESCE(SUM(fy.volume), 0) as volume,
                COALESCE(SUM(fy.Value), 0) as Value,
                YEAR(fy.harvest_date) as harvest_year,
                MONTH(fy.harvest_date) as harvest_month,
                DATE_FORMAT(fy.harvest_date, '%Y-%m') as month_year,
                DATE_FORMAT(fy.harvest_date, '%M') as month_name
            `;
            groupBy = productId ?
                'GROUP BY b.name, YEAR(fy.harvest_date), MONTH(fy.harvest_date), fy.product_id, p.name' :
                'GROUP BY b.name, YEAR(fy.harvest_date), MONTH(fy.harvest_date)';
        } else if (viewBy === 'Yearly') {
            selectFields = `
                b.name as barangay_name,
                ${productId ? 'fy.product_id' : 'NULL as product_id'},
                ${productId ? 'p.name as product_name' : 'NULL as product_name'},
                NULL as harvest_date,
                COALESCE(SUM(fy.volume), 0) as volume,
                COALESCE(SUM(fy.Value), 0) as Value,
                YEAR(fy.harvest_date) as harvest_year,
                NULL as harvest_month,
                YEAR(fy.harvest_date) as year
            `;
            groupBy = productId ?
                'GROUP BY b.name, YEAR(fy.harvest_date), fy.product_id, p.name' :
                'GROUP BY b.name, YEAR(fy.harvest_date)';
        } else {
            // Individual entries
            selectFields = `
                b.name as barangay_name,
                fy.product_id,
                p.name as product_name,
                fy.harvest_date,
                fy.volume,
                fy.Value,
                YEAR(fy.harvest_date) as harvest_year,
                MONTH(fy.harvest_date) as harvest_month
            `;
        }

        // Get barangays based on filter - FIXED: Only get filtered barangays
        let barangayQuery = 'SELECT name FROM barangay';
        let barangayParams = [];
        
        if (barangayName) {
            barangayQuery += ' WHERE name = ?';
            barangayParams.push(barangayName);
        }
        
        barangayQuery += ' ORDER BY name';
        const [barangays] = await pool.query(barangayQuery, barangayParams);

        // Main query that properly joins with farm_products table
        query = `
            SELECT 
                ${selectFields}
            FROM barangay b
            LEFT JOIN farms f ON b.name = f.parentBarangay
            LEFT JOIN farmer_yield fy ON f.farm_id = fy.farm_id AND (fy.status IS NULL OR fy.status = "Accepted")
            LEFT JOIN farmers fr ON f.farmer_id = fr.id
            LEFT JOIN farm_products p ON fy.product_id = p.id
            WHERE 1=1
        `;

        const conditions = [];
        const params = [];

        if (barangayName) {
            conditions.push('b.name = ?');
            params.push(barangayName);
        }

        if (productId) {
            conditions.push('fy.product_id = ?');
            params.push(productId);
        }

        if (sectorId) {
            conditions.push('fr.sector_id = ?');
            params.push(sectorId);
        }

        // Add date range filter if valid
        if (dateRangeValid) {
            conditions.push('fy.harvest_date BETWEEN ? AND ?');
            params.push(startDate, endDate);
        }

        if (conditions.length > 0) {
            query += ' AND ' + conditions.join(' AND ');
        }

        query += ` ${groupBy} ORDER BY `;

        // Adjust ordering based on viewBy
        if (viewBy === 'Monthly') {
            query += 'month_year DESC, barangay_name' + (productId ? ', product_name' : '');
        } else if (viewBy === 'Yearly') {
            query += 'year DESC, barangay_name' + (productId ? ', product_name' : '');
        } else {
            query += 'barangay_name, fy.harvest_date DESC';
        }

        // Add LIMIT clause if count is specified
        if (limitCount !== null) {
            query += ' LIMIT ?';
            params.push(limitCount);
        }

        const [yields] = await pool.query(query, params);

        // Format response
        let formattedYields;
        if (viewBy === 'Monthly') {
            formattedYields = yields.map(yield => ({
                barangay: yield.barangay_name,
                period: yield.month_year,
                period_display: `${yield.month_name} ${yield.harvest_year}`,
                product: yield.product_name || null,
                volume: parseFloat(yield.volume || 0),
                total_value: parseFloat(yield.Value || 0),
                year: yield.harvest_year,
                month: yield.harvest_month,
                month_name: yield.month_name
            }));
        } else if (viewBy === 'Yearly') {
            formattedYields = yields.map(yield => ({
                barangay: yield.barangay_name,
                period: yield.year?.toString() || '',
                product: yield.product_name || null,
                volume: parseFloat(yield.volume || 0),
                total_value: parseFloat(yield.Value || 0),
                year: yield.harvest_year
            }));
        } else {
            // Individual entries
            formattedYields = yields.map(yield => ({
                barangay: yield.barangay_name,
                product: yield.product_name || null,
                harvest_date: yield.harvest_date || null,
                volume: parseFloat(yield.volume || 0),
                value: parseFloat(yield.Value || 0)
            }));
        }

        // FIXED: Only apply the barangay padding logic when NO specific barangay is selected
        if ((viewBy === 'Monthly' || viewBy === 'Yearly') && barangays.length > 0 && !barangayName) {
            const barangayData = {};
            const firstYield = formattedYields[0] || {};

            barangays.forEach(barangay => {
                barangayData[barangay.name] = {
                    barangay: barangay.name,
                    period: firstYield.period || '',
                    period_display: viewBy === 'Monthly' ? (firstYield.period_display || '') : '',
                    product: productId ? (formattedYields.find(y => y.barangay === barangay.name)?.product || null) : null,
                    volume: 0,
                    total_value: 0,
                    year: firstYield.year || '',
                    month: viewBy === 'Monthly' ? (firstYield.month || '') : null,
                    month_name: viewBy === 'Monthly' ? (firstYield.month_name || '') : null
                };
            });

            // Merge with actual data
            formattedYields.forEach(yield => {
                if (barangayData[yield.barangay]) {
                    barangayData[yield.barangay] = yield;
                }
            });

            formattedYields = Object.values(barangayData);
        }

        res.json({
            success: true,
            filters: {
                barangayName: barangayName || 'all',
                productId: productId || 'all',
                sectorId: sectorId || 'all',
                startDate: dateRangeValid ? startDate : 'all',
                endDate: dateRangeValid ? endDate : 'all',
                viewBy: viewBy || 'individual',
                count: limitCount !== null ? limitCount : 'all'
            },
            count: formattedYields.length,
            yields: formattedYields
        });

    } catch (error) {
        console.error('Failed to fetch barangay yields:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch barangay yields',
            error: {
                code: 'BARANGAY_YIELD_FILTER_ERROR',
                details: error.message,
                sqlMessage: error.sqlMessage || 'No SQL error message'
            }
        });
    }
});




router.get('/farmers-report', async (req, res) => {
    try {
      const { barangay, sector, association } = req.query; // Added association parameter
  
      const countParam = req.query.count ? req.query.count.trim().toLowerCase() : 'all';
      
      // Parse count parameter - if it's a number use it, otherwise return all
      const count = countParam === 'all' ? null : parseInt(countParam);
      const limitCount = Number.isInteger(count) && count > 0 ? count : null;
  
      // Base query with optional filters
      let query = `
        SELECT 
          f.id,
          CONCAT(f.firstname, 
                 IF(f.middlename IS NULL, '', CONCAT(' ', f.middlename)), 
                 IF(f.surname IS NULL, '', CONCAT(' ', f.surname)),
                 IF(f.extension IS NULL, '', CONCAT(' ', f.extension))) as name,
          f.phone as contact,
          f.barangay,
          s.sector_name as sector,
          s.sector_id,
          a.name as association_name,  -- Added association name
          a.id as association_id,      -- Added association id
          COALESCE(SUM(farm.area), 0) as area,
          GROUP_CONCAT(DISTINCT fp.name SEPARATOR ', ') as products,
          GROUP_CONCAT(DISTINCT farm.farm_name SEPARATOR ', ') as farms,
          COALESCE(SUM(fy.volume), 0) as production_value
        FROM farmers f
        LEFT JOIN sectors s ON f.sector_id = s.sector_id
        LEFT JOIN associations a ON f.assoc_id = a.id  -- Joined with associations table
        LEFT JOIN farms farm ON f.id = farm.farmer_id
        LEFT JOIN farmer_yield fy ON f.id = fy.farmer_id AND (fy.volume IS NULL OR fy.volume > 0)  -- Filter out 0 volumes here
        LEFT JOIN farm_products fp ON fy.product_id = fp.id
      `;
  
      const conditions = [];
      const params = [];
  
      if (barangay && barangay !== 'all') {
        conditions.push('f.barangay = ?');
        params.push(barangay);
      }

      conditions.push('(fy.status IS NULL OR fy.status = "Accepted")');
  
      if (sector && sector !== 'all') {
        // Extract just the number part before the colon
        const sectorId = sector.split(':')[0];
        conditions.push('s.sector_id = ?');
        params.push(sectorId);
      }
  
      if (association && association !== 'all') {
        conditions.push('a.id = ?');
        params.push(association);
      }
  
      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      } else {
        query += ' WHERE (fy.status IS NULL OR fy.status = "Accepted")';
      }
  
      query += ' GROUP BY f.id';
  
      // Add LIMIT clause if count is specified
      if (limitCount !== null) {
        query += ' LIMIT ?';
        params.push(limitCount);
      }
  
      const [farmers] = await pool.query(query, params);
  
      // Format the response
      const responseData = farmers.map(farmer => ({
        'Name': farmer.name,
        'Contact': farmer.contact,
        'Barangay': farmer.barangay,
        'Sector': farmer.sector,
        'Association': farmer.association_name || 'None', // Added association
        'Farms': farmer.farms ? farmer.farms.split(', ') : [],
        'Products': farmer.products ? farmer.products.split(', ') : [],
        '(Mt | Heads)': parseFloat(farmer.production_value) || 0,
        'Area': parseFloat(farmer.area) || 0,
      }));
  
      res.json({
        success: true,
        filters: {
          barangay: barangay || 'all',
          sector: sector || 'all',
          association: association || 'all',
           count: limitCount !== null ? limitCount : 'all'
        },
        count: responseData.length,
        farmers: responseData
      });
  
    } catch (error) {
      console.error('Failed to fetch farmer summary:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch farmer summary',
        error: {
          code: 'FARMER_SUMMARY_ERROR',
          details: error.message,
          sqlMessage: error.sqlMessage || 'No SQL error message'
        }
      });
    }
  });





  
  router.get('/sector-yields-report', async (req, res) => {
    try {
      // Extract and clean the sector ID
      const sectorId = req.query.sectorId ? req.query.sectorId.split(':')[0].trim() : null;
  
  
  
      const countParam = req.query.count ? req.query.count.trim().toLowerCase() : 'all';
  
      
      // Parse count parameter - if it's a number use it, otherwise return all
      const count = countParam === 'all' ? null : parseInt(countParam);
      const limitCount = Number.isInteger(count) && count > 0 ? count : null;
  
  
      // Other params
      const { startDate, endDate, viewBy } = req.query;
  
      // Validate date range
      const dateRangeValid = startDate && endDate && startDate !== endDate;
  
      let query;
      let groupBy = '';
      let selectFields = `
        s.sector_id,
        s.sector_name,
        NULL as product_id,
        'All Products' as product_name,
        NULL as harvest_date,
        NULL as volume,
        NULL as Value,
        NULL as harvest_year,
        NULL as harvest_month
      `;
  
      if (viewBy === 'Monthly') {
        selectFields = `
          s.sector_id,
          s.sector_name,
          NULL as product_id,
          'All Products' as product_name,
          NULL as harvest_date,
          COALESCE(SUM(fy.volume), 0) as volume,
          COALESCE(SUM(fy.Value), 0) as Value,
          YEAR(fy.harvest_date) as harvest_year,
          MONTH(fy.harvest_date) as harvest_month,
          DATE_FORMAT(fy.harvest_date, '%Y-%m') as month_year,
          DATE_FORMAT(fy.harvest_date, '%M') as month_name
        `;
        groupBy = 'GROUP BY s.sector_id, YEAR(fy.harvest_date), MONTH(fy.harvest_date)';
      } else if (viewBy === 'Yearly') {
        selectFields = `
          s.sector_id,
          s.sector_name,
          NULL as product_id,
          'All Products' as product_name,
          NULL as harvest_date,
          COALESCE(SUM(fy.volume), 0) as volume,
          COALESCE(SUM(fy.Value), 0) as Value,
          YEAR(fy.harvest_date) as harvest_year,
          NULL as harvest_month,
          YEAR(fy.harvest_date) as year
        `;
        groupBy = 'GROUP BY s.sector_id, YEAR(fy.harvest_date)';
      } else {
        // Individual entries
        selectFields = `
          s.sector_id,
          s.sector_name,
          NULL as product_id,
          'All Products' as product_name,
          fy.harvest_date,
          fy.volume,
          fy.Value,
          YEAR(fy.harvest_date) as harvest_year,
          MONTH(fy.harvest_date) as harvest_month
        `;
      }
  
  
  
      const [sectors] = await pool.query('SELECT sector_id, sector_name FROM sectors ORDER BY sector_name');
  
      query = `
        SELECT 
          ${selectFields}
        FROM sectors s
        LEFT JOIN farmers f ON s.sector_id = f.sector_id
        LEFT JOIN farms farm ON f.id = farm.farmer_id
        LEFT JOIN farmer_yield fy ON farm.farm_id = fy.farm_id
        WHERE 1=1
      `;
  
      const conditions = [];
      const params = [];
  
      if (sectorId) {
        conditions.push('s.sector_id = ?');
        params.push(sectorId);
      }
  
      // Add date range filter if valid
      if (dateRangeValid) {
        conditions.push('(fy.harvest_date IS NULL OR fy.harvest_date BETWEEN ? AND ?)');
        params.push(startDate, endDate);
      }
  
      if (conditions.length > 0) {
        query += ' AND ' + conditions.join(' AND ');
      }
  
      query += ` ${groupBy} ORDER BY `;
  
      // Adjust ordering based on viewBy
      if (viewBy === 'Monthly') {
        query += 'month_year DESC, sector_name';
      } else if (viewBy === 'Yearly') {
        query += 'year DESC, sector_name';
      } else {
        query += 'sector_name, fy.harvest_date DESC';
      }
  
  
        // Add LIMIT clause if count is specified
        if (limitCount !== null) {
          query += ' LIMIT ?';
          params.push(limitCount);
        }
  
      const [yields] = await pool.query(query, params);
  
      // Format response
      let formattedYields;
      if (viewBy === 'Monthly') {
        formattedYields = yields.map(yield => ({
          sector_id: yield.sector_id,
          sector_name: yield.sector_name,
          period: yield.month_year,
          period_display: `${yield.month_name} ${yield.harvest_year}`,
          product: 'All Products',
          volume: parseFloat(yield.volume),
          total_value: yield.Value ? parseFloat(yield.Value) : 0,
          year: yield.harvest_year,
          month: yield.harvest_month,
          month_name: yield.month_name
        }));
      } else if (viewBy === 'Yearly') {
        formattedYields = yields.map(yield => ({
          sector_id: yield.sector_id,
          sector_name: yield.sector_name,
          period: yield.year.toString(),
          product: 'All Products',
          volume: parseFloat(yield.volume),
          total_value: yield.Value ? parseFloat(yield.Value) : 0,
          year: yield.harvest_year
        }));
      } else {
        // Individual entries
        formattedYields = yields.map(yield => ({
          sector_id: yield.sector_id,
          sector_name: yield.sector_name,
          product: 'All Products',
          harvest_date: yield.harvest_date || null,
          volume: yield.volume ? parseFloat(yield.volume) : 0,
          value: yield.Value ? parseFloat(yield.Value) : 0
        }));
      }
  
      if (viewBy === 'Monthly' || viewBy === 'Yearly') {
        const sectorData = {};
  
        sectors.forEach(sector => {
          sectorData[sector.sector_id] = {
            sector_id: sector.sector_id,
            sector_name: sector.sector_name,
            period: viewBy === 'Monthly' ? (formattedYields[0]?.period || '') : (formattedYields[0]?.period || ''),
            period_display: viewBy === 'Monthly' ? (formattedYields[0]?.period_display || '') : '',
            product: 'All Products',
            volume: 0,
            total_value: 0,
            year: viewBy === 'Monthly' ? (formattedYields[0]?.year || '') : (formattedYields[0]?.year || ''),
            month: viewBy === 'Monthly' ? (formattedYields[0]?.month || '') : null,
            month_name: viewBy === 'Monthly' ? (formattedYields[0]?.month_name || '') : null
          };
        });
  
        // Merge with actual data
        formattedYields.forEach(yield => {
          sectorData[yield.sector_id] = yield;
        });
  
        formattedYields = Object.values(sectorData);
      }
  
      res.json({
        success: true,
        filters: {
          sectorId: sectorId || 'all',
          startDate: dateRangeValid ? startDate : 'all',
          endDate: dateRangeValid ? endDate : 'all',
          viewBy: viewBy || 'individual',
                    count: limitCount !== null ? limitCount : 'all'
        },
        count: formattedYields.length,
        yields: formattedYields
      });
  
    } catch (error) {
      console.error('Failed to fetch sector yields:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch sector yields',
        error: {
          code: 'SECTOR_YIELD_FILTER_ERROR',
          details: error.message,
          sqlMessage: error.sqlMessage || 'No SQL error message'
        }
      });
    }
  });
  
  router.get('/farmer-yields-report', async (req, res) => {
    try {
      // Extract and clean the IDs
      const farmerId = req.query.farmerId ? req.query.farmerId.split(':')[0].trim() : null;
      const barangayName = req.query.barangayName ? req.query.barangayName.trim() : null;
      const productId = req.query.productId ? req.query.productId.split(':')[0].trim() : null;
      const associationId = req.query.associationId ? req.query.associationId.split(':')[0].trim() : null; // Added association filter
      const countParam = req.query.count ? req.query.count.trim().toLowerCase() : 'all';
  
      const count = countParam === 'all' ? null : parseInt(countParam);
      const limitCount = Number.isInteger(count) && count > 0 ? count : null;
  
      // Other params
  
      const { startDate, endDate, viewBy } = req.query;
  
      // Validate date range
      const dateRangeValid = startDate && endDate && startDate !== endDate;
  
      
  
      // Base query with optional filters
      let query = `
        SELECT 
          fy.id,
          farm.farmer_id,
          CONCAT(f.firstname, 
                 IF(f.middlename IS NULL, '', CONCAT(' ', f.middlename)), 
                 IF(f.surname IS NULL, '', CONCAT(' ', f.surname)),
                 IF(f.extension IS NULL, '', CONCAT(' ', f.extension))) as farmer_name,
          b.name as barangay_name,
          fy.product_id,
          p.name as product_name,
          a.name as association_name,
          a.id as association_id,
          fy.harvest_date,
          fy.status,
          fy.volume,
          fy.Value,
          YEAR(fy.harvest_date) as harvest_year,
          MONTH(fy.harvest_date) as harvest_month,
          farm.farm_id
        FROM farmer_yield fy
        JOIN farms farm ON fy.farm_id = farm.farm_id
        JOIN farmers f ON farm.farmer_id = f.id
        JOIN barangay b ON farm.parentBarangay = b.name
        LEFT JOIN farm_products p ON fy.product_id = p.id
        LEFT JOIN associations a ON f.assoc_id = a.id
      `;
  
      const conditions = [];
      const params = [];
  
      conditions.push('fy.status IS NOT NULL AND fy.status = "Accepted"');

      if (farmerId && farmerId !== 'all') {
        conditions.push('farm.farmer_id = ?');
        params.push(farmerId);
      }
  
      if (barangayName && barangayName !== 'all') {
        conditions.push('b.name = ?');
        params.push(barangayName);
      }
  
      if (productId && productId !== 'all') {
        conditions.push('fy.product_id = ?');
        params.push(productId);
      }
  
      if (associationId && associationId !== 'all') {
        conditions.push('a.id = ?');
        params.push(associationId);
      }
  
      if (dateRangeValid) {
        conditions.push('fy.harvest_date BETWEEN ? AND ?');
        params.push(startDate, endDate);
      }
  
      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      } else {
      }
  
      // Handle viewBy options
      if (viewBy === 'Monthly') {
        query = `
          SELECT 
            NULL as id,
            farm.farmer_id,
            CONCAT(f.firstname, 
                   IF(f.middlename IS NULL, '', CONCAT(' ', f.middlename)), 
                   IF(f.surname IS NULL, '', CONCAT(' ', f.surname)),
                   IF(f.extension IS NULL, '', CONCAT(' ', f.extension))) as farmer_name,
            b.name as barangay_name,
            fy.product_id,
            p.name as product_name,
            a.name as association_name,
            a.id as association_id,
            NULL as harvest_date,
            SUM(fy.volume) as volume,
            SUM(fy.Value) as Value,
            YEAR(fy.harvest_date) as harvest_year,
            MONTH(fy.harvest_date) as harvest_month,
            DATE_FORMAT(fy.harvest_date, '%Y-%m') as month_year,
            DATE_FORMAT(fy.harvest_date, '%M') as month_name,
            LAST_DAY(fy.harvest_date) as period_date
          FROM farmer_yield fy
          JOIN farms farm ON fy.farm_id = farm.farm_id
          JOIN farmers f ON farm.farmer_id = f.id
          JOIN barangay b ON farm.parentBarangay = b.name
          LEFT JOIN farm_products p ON fy.product_id = p.id
          LEFT JOIN associations a ON f.assoc_id = a.id
          ${conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : ''}
          GROUP BY YEAR(fy.harvest_date), MONTH(fy.harvest_date), farm.farmer_id, fy.product_id, a.id
          ORDER BY month_year DESC, farmer_name, product_name, association_name
        `;
      } else if (viewBy === 'Yearly') {
        query = `
          SELECT 
            NULL as id,
            farm.farmer_id,
            CONCAT(f.firstname, 
                   IF(f.middlename IS NULL, '', CONCAT(' ', f.middlename)), 
                   IF(f.surname IS NULL, '', CONCAT(' ', f.surname)),
                   IF(f.extension IS NULL, '', CONCAT(' ', f.extension))) as farmer_name,
            b.name as barangay_name,
            fy.product_id,
            p.name as product_name,
            a.name as association_name,
            a.id as association_id,
            NULL as harvest_date,
            SUM(fy.volume) as volume,
            SUM(fy.Value) as Value,
            YEAR(fy.harvest_date) as harvest_year,
            NULL as harvest_month,
            YEAR(fy.harvest_date) as year,
            MAX(fy.harvest_date) as period_date
          FROM farmer_yield fy
          JOIN farms farm ON fy.farm_id = farm.farm_id
          JOIN farmers f ON farm.farmer_id = f.id
          JOIN barangay b ON farm.parentBarangay = b.name
          LEFT JOIN farm_products p ON fy.product_id = p.id
          LEFT JOIN associations a ON f.assoc_id = a.id
          ${conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : ''}
          GROUP BY YEAR(fy.harvest_date), farm.farmer_id, fy.product_id, a.id
          ORDER BY year DESC, farmer_name, product_name, association_name
        `;
      } else {
        query += ' ORDER BY fy.harvest_date DESC, farmer_name, product_name, association_name';
      }
  
       // Add LIMIT clause if count is specified
       if (limitCount !== null) {
        query += ' LIMIT ?';
        params.push(limitCount);
      }
  
      
  
      const [yields] = await pool.query(query, params);
  
      // Format response
      const formattedYields = yields.map(yield => {
        const baseData = {
          farmer_id: yield.farmer_id,
          farmer_name: yield.farmer_name,
          barangay: yield.barangay_name,
          product: yield.product_name,
          association: yield.association_name || 'None',
          volume: parseFloat(yield.volume) || 0, 
          total_value: yield.Value ? parseFloat(yield.Value) : null
        };
  
        if (viewBy === 'Monthly') {
          return {
            ...baseData,
            period: yield.month_year,
            period_display: `${yield.month_name} ${yield.harvest_year}`,
            harvest_date: new Date(yield.period_date).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long'
            }),
            year: yield.harvest_year,
            month: yield.harvest_month,
            month_name: yield.month_name
          };
        } else if (viewBy === 'Yearly') {
          return {
            ...baseData,
            period: yield.year.toString(),
            harvest_date: new Date(yield.period_date).toLocaleDateString('en-US', {
              year: 'numeric'
            }),
            year: yield.harvest_year
          };
        } else {
          return {
            ...baseData,
            harvest_date: new Date(yield.harvest_date).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric'
            }),
          };
        }
      });
  
      res.json({
        success: true,
        filters: {
          farmerId: farmerId || 'all',
          barangayName: barangayName || 'all',
          productId: productId || 'all',
          associationId: associationId || 'all',
          startDate: dateRangeValid ? startDate : 'all',
          endDate: dateRangeValid ? endDate : 'all',
          viewBy: viewBy || 'individual',
            count: limitCount !== null ? limitCount : 'all'
        },
        count: formattedYields.length,
        yields: formattedYields
      });
  
    } catch (error) {
      console.error('Failed to fetch farmer yields:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch farmer yields',
        error: {
          code: 'FARMER_YIELD_FILTER_ERROR',
          details: error.message,
          sqlMessage: error.sqlMessage || 'No SQL error message'
        }
      });
    }
  });
  
  
  
  router.get('/product-yields-report', async (req, res) => {
    try {
      // Extract and clean the IDs (keep only the numeric part)
      const productId = req.query.productId ? req.query.productId.split(':')[0].trim() : null;
      const sectorId = req.query.sectorId ? req.query.sectorId.split(':')[0].trim() : null;
      const barangayName = req.query.barangayName ? req.query.barangayName.trim() : null;
      const countParam = req.query.count ? req.query.count.trim().toLowerCase() : 'all';
  
      // Other params
      const { startDate, endDate, viewBy } = req.query;
  
      // Validate date range
      const dateRangeValid = startDate && endDate && startDate !== endDate;
  
      // Parse count parameter - if it's a number use it, otherwise return all
      const count = countParam === 'all' ? null : parseInt(countParam);
      const limitCount = Number.isInteger(count) && count > 0 ? count : null;
  
      let query;
      let groupBy = '';
      let selectFields = `
        fy.id,
        fy.product_id,
        p.name as product_name,
        p.sector_id,
        s.sector_name,
        fy.harvest_date,
        fy.volume,
        fy.Value,
        fy.status,
        YEAR(fy.harvest_date) as harvest_year,
        MONTH(fy.harvest_date) as harvest_month,
        farm.farm_name,
        b.name as barangay_name
      `;
  
      if (viewBy === 'Monthly') {
        selectFields = `
          NULL as id,
          fy.product_id,
          p.name as product_name,
          p.sector_id,
          s.sector_name,
          NULL as harvest_date,
          SUM(fy.volume) as volume,
          SUM(fy.Value) as Value,
          YEAR(fy.harvest_date) as harvest_year,
          MONTH(fy.harvest_date) as harvest_month,
          DATE_FORMAT(fy.harvest_date, '%Y-%m') as month_year,
          DATE_FORMAT(fy.harvest_date, '%M') as month_name,
          LAST_DAY(fy.harvest_date) as period_date,
          GROUP_CONCAT(DISTINCT farm.farm_name) as farm_names,
          GROUP_CONCAT(DISTINCT b.name) as barangay_names
        `;
        groupBy = 'GROUP BY YEAR(fy.harvest_date), MONTH(fy.harvest_date), fy.product_id, p.sector_id';
      } else if (viewBy === 'Yearly') {
        selectFields = `
          NULL as id,
          fy.product_id,
          p.name as product_name,
          p.sector_id,
          s.sector_name,
          NULL as harvest_date,
          SUM(fy.volume) as volume,
          SUM(fy.Value) as Value,
          YEAR(fy.harvest_date) as harvest_year,
          NULL as harvest_month,
          YEAR(fy.harvest_date) as year,
          MAX(fy.harvest_date) as period_date,
          GROUP_CONCAT(DISTINCT farm.farm_name) as farm_names,
          GROUP_CONCAT(DISTINCT b.name) as barangay_names
        `;
        groupBy = 'GROUP BY YEAR(fy.harvest_date), fy.product_id, p.sector_id';
      }
  
      query = `
        SELECT 
          ${selectFields}
        FROM farmer_yield fy
        JOIN farm_products p ON fy.product_id = p.id
        LEFT JOIN sectors s ON p.sector_id = s.sector_id
        JOIN farms farm ON fy.farm_id = farm.farm_id
        JOIN barangay b ON farm.parentBarangay = b.name
        WHERE 1=1
      `;
  

      
      const conditions = [];
      const params = [];

      conditions.push('(fy.status IS NULL OR fy.status = "Accepted")');
  
      if (productId) {
        conditions.push('fy.product_id = ?');
        params.push(productId);
      }
  
      if (sectorId) {
        conditions.push('p.sector_id = ?');
        params.push(sectorId);
      }
  
      if (barangayName && barangayName !== 'all') {
        conditions.push('b.name = ?');
        params.push(barangayName);
      }
  
      if (dateRangeValid) {
        conditions.push('fy.harvest_date BETWEEN ? AND ?');
        params.push(startDate, endDate);
      }
  
      if (conditions.length > 0) {
        query += ' AND ' + conditions.join(' AND ');
      }
  
      query += ` ${groupBy} ORDER BY `;
  
      if (viewBy === 'Monthly') {
        query += 'month_year DESC, product_name, sector_name';
      } else if (viewBy === 'Yearly') {
        query += 'year DESC, product_name, sector_name';
      } else {
        query += 'fy.harvest_date DESC, product_name, sector_name';
      }
  
      // Add LIMIT clause if count is specified
      if (limitCount !== null) {
        query += ' LIMIT ?';
        params.push(limitCount);
      }
  
      const [yields] = await pool.query(query, params);
  
      // Format response with consistent harvest_date field
      let formattedYields;
      if (viewBy === 'Monthly') {
        formattedYields = yields.map(yield => {
          const harvestDate = new Date(yield.period_date);
          const formattedDate = harvestDate.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long'
          });
  
          return {
            period: yield.month_year,
            period_display: `${yield.month_name} ${yield.harvest_year}`,
            product: yield.product_name,
            sector: yield.sector_name,
            volume: parseFloat(yield.volume),
            total_value: yield.Value ? parseFloat(yield.Value) : null,
            harvest_date: formattedDate,
            year: yield.harvest_year,
            month: yield.harvest_month,
            month_name: yield.month_name,
            barangays: yield.barangay_names ? yield.barangay_names.split(',') : [],
            farms: yield.farm_names ? yield.farm_names.split(',') : []
          };
        });
      } else if (viewBy === 'Yearly') {
        formattedYields = yields.map(yield => {
          const harvestDate = new Date(yield.period_date);
          const formattedDate = harvestDate.toLocaleDateString('en-US', {
            year: 'numeric'
          });
  
          return {
            period: yield.year.toString(),
            product: yield.product_name,
            sector: yield.sector_name,
            volume: parseFloat(yield.volume),
            total_value: yield.Value ? parseFloat(yield.Value) : null,
            harvest_date: formattedDate,
            year: yield.harvest_year,
            barangays: yield.barangay_names ? yield.barangay_names.split(',') : [],
            farms: yield.farm_names ? yield.farm_names.split(',') : []
          };
        });
      } else {
        // Individual entries
        formattedYields = yields.map(yield => {
          const harvestDate = new Date(yield.harvest_date);
          const formattedDate = harvestDate.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          });
  
          return {
            product: yield.product_name,
            sector: yield.sector_name,
            harvest_date: formattedDate,
            volume: parseFloat(yield.volume),
            value: yield.Value ? parseFloat(yield.Value) : null,
            farm_name: yield.farm_name,
            barangay: yield.barangay_name
          };
        });
      }
  
      res.json({
        success: true,
        filters: {
          productId: productId || 'all',
          sectorId: sectorId || 'all',
          barangayName: barangayName || 'all',
          startDate: dateRangeValid ? startDate : 'all',
          endDate: dateRangeValid ? endDate : 'all',
          viewBy: viewBy || 'individual',
          count: limitCount !== null ? limitCount : 'all'
        },
        count: formattedYields.length,
        yields: formattedYields
      });
  
    } catch (error) {
      console.error('Failed to fetch product yields:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch product yields',
        error: {
          code: 'PRODUCT_YIELD_FILTER_ERROR',
          details: error.message,
          sqlMessage: error.sqlMessage || 'No SQL error message'
        }
      });
    }
  });
  





module.exports = router;