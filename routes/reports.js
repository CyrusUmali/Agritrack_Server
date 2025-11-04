// yieldsRoutes.js
const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/firebase-auth-middleware');
const admin = require('firebase-admin');
const pool = require('../connect');



// Helper function to safely format area_harvested
const formatAreaHarvested = (area) => {
  if (area === null || area === undefined) return 0;
  return parseFloat(Number(area).toFixed(2));
};

router.get('/sector-yields-report', authenticate, async (req, res) => {
  try {
    // Extract and clean the IDs
    const sectorId = req.query.sectorId ? req.query.sectorId.split(':')[0].trim() : null;
    const productId = req.query.productId ? req.query.productId.split(':')[0].trim() : null;

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
          p.sector_id,
          s.sector_name,
          fy.product_id,
          p.name as product_name,
          NULL as harvest_date,
          NULL as volume,
          NULL as Value,
          NULL as area_harvested,
          NULL as harvest_year,
          NULL as harvest_month
      `;

    if (viewBy === 'Monthly') {
      selectFields = `
              p.sector_id,
              s.sector_name,
              fy.product_id,
              p.name as product_name,
              NULL as harvest_date,
              COALESCE(SUM(fy.volume), 0) as volume,
              COALESCE(SUM(fy.Value), 0) as Value,
              COALESCE(SUM(fy.area_harvested), 0) as area_harvested,
              YEAR(fy.harvest_date) as harvest_year,
              MONTH(fy.harvest_date) as harvest_month,
              DATE_FORMAT(fy.harvest_date, '%Y-%m') as month_year,
              DATE_FORMAT(fy.harvest_date, '%M') as month_name
          `;
      groupBy = 'GROUP BY p.sector_id, YEAR(fy.harvest_date), MONTH(fy.harvest_date), fy.product_id, p.name';
    } else if (viewBy === 'Yearly') {
      selectFields = `
              p.sector_id,
              s.sector_name,
              fy.product_id,
              p.name as product_name,
              NULL as harvest_date,
              COALESCE(SUM(fy.volume), 0) as volume,
              COALESCE(SUM(fy.Value), 0) as Value,
              COALESCE(SUM(fy.area_harvested), 0) as area_harvested,
              YEAR(fy.harvest_date) as harvest_year,
              MONTH(fy.harvest_date) as harvest_month,
              DATE_FORMAT(fy.harvest_date, '%Y') as year,
              DATE_FORMAT(fy.harvest_date, '%M') as month_name,
              DATE_FORMAT(fy.harvest_date, '%Y') as year_display
          `;
      groupBy = 'GROUP BY p.sector_id, YEAR(fy.harvest_date), fy.product_id, p.name';
    } else {
      // Individual entries
      selectFields = `
              p.sector_id,
              s.sector_name,
              fy.product_id,
              p.name as product_name,
              fy.harvest_date,
              fy.volume,
              fy.Value,
              fy.area_harvested,
              YEAR(fy.harvest_date) as harvest_year,
              MONTH(fy.harvest_date) as harvest_month
          `;
    }

    // Get sectors based on filter
    let sectorQuery = 'SELECT sector_id, sector_name FROM sectors';
    let sectorParams = [];

    if (sectorId) {
      sectorQuery += ' WHERE sector_id = ?';
      sectorParams.push(sectorId);
    }

    sectorQuery += ' ORDER BY sector_name';
    const [sectors] = await pool.query(sectorQuery, sectorParams);

    // Main query
    query = `
          SELECT 
              ${selectFields}
          FROM farm_products p
          LEFT JOIN sectors s ON p.sector_id = s.sector_id
          LEFT JOIN farmer_yield fy ON p.id = fy.product_id AND (fy.status IS NULL OR fy.status = "Accepted")
          LEFT JOIN farms farm ON fy.farm_id = farm.farm_id
          LEFT JOIN farmers f ON farm.farmer_id = f.id
          WHERE 1=1
      `;

    const conditions = [];
    const params = [];

    if (sectorId) {
      conditions.push('p.sector_id = ?');
      params.push(sectorId);
    }

    if (productId) {
      conditions.push('fy.product_id = ?');
      params.push(productId);
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
      query += 'month_year DESC, sector_name, product_name';
    } else if (viewBy === 'Yearly') {
      query += 'year DESC, sector_name, product_name';
    } else {
      query += 'sector_name, fy.harvest_date DESC, product_name';
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
        sector_name: yield.sector_name,
        period: yield.month_year,
        harvest_date: `${yield.month_name} ${yield.harvest_year}`,
        product: yield.product_id ? {
          id: yield.product_id,
          name: yield.product_name,
        } : null,
        volume: parseFloat(yield.volume || 0),
        total_value: parseFloat(yield.Value || 0),
        area_harvested: formatAreaHarvested(yield.area_harvested),
        year: yield.harvest_year,
        month: yield.harvest_month,
        month_name: yield.month_name,
      }));
    } else if (viewBy === 'Yearly') {
      formattedYields = yields.map(yield => ({
        sector_name: yield.sector_name,
        period: yield.year,
        harvest_date: yield.year_display,
        product: yield.product_id ? {
          id: yield.product_id,
          name: yield.product_name,
        } : null,
        volume: parseFloat(yield.volume || 0),
        total_value: parseFloat(yield.Value || 0),
        area_harvested: formatAreaHarvested(yield.area_harvested),
        year: yield.harvest_year,
        month: yield.harvest_month,
        month_name: yield.month_name,
        year_display: yield.year_display
      }));
    } else {
      // Individual entries
      formattedYields = yields.map(yield => ({
        sector_name: yield.sector_name,
        product: yield.product_name,
        harvest_date: yield.harvest_date ?
          new Date(yield.harvest_date).toISOString().split('T')[0] : null,
        volume: parseFloat(yield.volume || 0),
        value: parseFloat(yield.Value || 0),
        area_harvested: formatAreaHarvested(yield.area_harvested)
      }));
    }

    // Group by period and include all products when no specific product is selected
    if ((viewBy === 'Monthly' || viewBy === 'Yearly') && !productId) {
      const groupedData = {};

      formattedYields.forEach(yield => {
        const key = `${yield.sector_id}_${yield.period}`;
        if (!groupedData[key]) {
          groupedData[key] = {
            sector_name: yield.sector_name,
            period: yield.period,
            period_display: viewBy === 'Monthly' ? `${yield.month_name} ${yield.year}` : yield.year_display,
            year: yield.year,
            month: yield.month,
            month_name: yield.month_name,
            total_volume: 0,
            total_value: 0,
            total_area_harvested: 0,
            products: []
          };
        }

        if (yield.product && yield.product.name) {
          if (!groupedData[key].products.includes(yield.product.name)) {
            groupedData[key].products.push(yield.product.name);
          }
        }

        groupedData[key].total_volume += yield.volume;
        groupedData[key].total_value += yield.total_value;
        groupedData[key].total_area_harvested += yield.area_harvested;
      });

      // Convert to array format
      formattedYields = Object.values(groupedData).map(item => ({
        sector_name: item.sector_name,
        period: item.period,
        period_display: item.period_display,
        year: item.year,
        month: item.month,
        month_name: item.month_name,
        volume: item.total_volume,
        total_value: item.total_value,
        area_harvested: formatAreaHarvested(item.total_area_harvested),
        harvest_date: item.period_display,
        product: item.products.join(', ')
      }));
    }

    res.json({
      success: true,
      filters: {
        sectorId: sectorId || 'all',
        productId: productId || 'all',
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


router.get('/barangay-yields-report' , authenticate ,  async (req, res) => {
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
            NULL as area_harvested,
            NULL as harvest_year,
            NULL as harvest_month
        `;

    if (viewBy === 'Monthly') {
      selectFields = `
                b.name as barangay_name,
                fy.product_id,
                p.name as product_name, 
                NULL as harvest_date,
                COALESCE(SUM(fy.volume), 0) as volume,
                COALESCE(SUM(fy.Value), 0) as Value,
                COALESCE(SUM(fy.area_harvested), 0) as area_harvested,
                YEAR(fy.harvest_date) as harvest_year,
                MONTH(fy.harvest_date) as harvest_month,
                DATE_FORMAT(fy.harvest_date, '%Y-%m') as month_year,
                DATE_FORMAT(fy.harvest_date, '%M') as month_name
            `;
      groupBy = 'GROUP BY b.name, YEAR(fy.harvest_date), MONTH(fy.harvest_date), fy.product_id, p.name ';
    } else if (viewBy === 'Yearly') {
      selectFields = `
                b.name as barangay_name,
                fy.product_id,
                p.name as product_name, 
                NULL as harvest_date,
                COALESCE(SUM(fy.volume), 0) as volume,
                COALESCE(SUM(fy.Value), 0) as Value,
                COALESCE(SUM(fy.area_harvested), 0) as area_harvested,
                YEAR(fy.harvest_date) as harvest_year,
                MONTH(fy.harvest_date) as harvest_month,
                DATE_FORMAT(fy.harvest_date, '%Y') as year,
                DATE_FORMAT(fy.harvest_date, '%M') as month_name,
                DATE_FORMAT(fy.harvest_date, '%Y') as year_display
            `;
      groupBy = 'GROUP BY b.name, YEAR(fy.harvest_date), fy.product_id, p.name';
    } else {
      // Individual entries
      selectFields = `
                b.name as barangay_name,
                fy.product_id,
                p.name as product_name, 
                fy.harvest_date,
                fy.volume,
                fy.Value,
                fy.area_harvested,
                YEAR(fy.harvest_date) as harvest_year,
                MONTH(fy.harvest_date) as harvest_month
            `;
    }

    // Get barangays based on filter
    let barangayQuery = 'SELECT name FROM barangay';
    let barangayParams = [];

    if (barangayName) {
      barangayQuery += ' WHERE name = ?';
      barangayParams.push(barangayName);
    }

    barangayQuery += ' ORDER BY name';
    const [barangays] = await pool.query(barangayQuery, barangayParams);

    // Main query
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
      query += 'month_year DESC, barangay_name, product_name';
    } else if (viewBy === 'Yearly') {
      query += 'year DESC, barangay_name, product_name';
    } else {
      query += 'barangay_name, fy.harvest_date DESC, product_name';
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
        harvest_date: `${yield.month_name} ${yield.harvest_year}`,
        product: yield.product_id ? {
          id: yield.product_id,
          name: yield.product_name,
        } : null,
        volume: parseFloat(yield.volume || 0),
        total_value: parseFloat(yield.Value || 0),
        area_harvested: formatAreaHarvested(yield.area_harvested),
        year: yield.harvest_year,
        month: yield.harvest_month,
        month_name: yield.month_name,
      }));
    } else if (viewBy === 'Yearly') {
      formattedYields = yields.map(yield => ({
        barangay: yield.barangay_name,
        period: yield.year,
        harvest_date: yield.year_display,
        product: yield.product_id ? {
          id: yield.product_id,
          name: yield.product_name,
        } : null,
        volume: parseFloat(yield.volume || 0),
        total_value: parseFloat(yield.Value || 0),
        area_harvested: formatAreaHarvested(yield.area_harvested),
        year: yield.harvest_year,
        month: yield.harvest_month,
        month_name: yield.month_name,
        year_display: yield.year_display
      }));
    } else {
      // Individual entries
      formattedYields = yields.map(yield => ({
        barangay: yield.barangay_name,
        product: yield.product_name,
        harvest_date: yield.harvest_date ?
          new Date(yield.harvest_date).toISOString().split('T')[0] : null,
        volume: parseFloat(yield.volume || 0),
        value: parseFloat(yield.Value || 0),
        area_harvested: formatAreaHarvested(yield.area_harvested)
      }));
    }

    // Group by period and include all products when no specific product is selected
    if ((viewBy === 'Monthly' || viewBy === 'Yearly') && !productId) {
      const groupedData = {};

      formattedYields.forEach(yield => {
        const key = `${yield.barangay}_${yield.period}`;
        if (!groupedData[key]) {
          groupedData[key] = {
            barangay: yield.barangay,
            period: yield.period,
            period_display: viewBy === 'Monthly' ? `${yield.month_name} ${yield.year}` : yield.year_display,
            year: yield.year,
            month: yield.month,
            month_name: yield.month_name,
            total_volume: 0,
            total_value: 0,
            total_area_harvested: 0,
            products: []
          };
        }

        if (yield.product && yield.product.name) {
          if (!groupedData[key].products.includes(yield.product.name)) {
            groupedData[key].products.push(yield.product.name);
          }
        }

        groupedData[key].total_volume += yield.volume;
        groupedData[key].total_value += yield.total_value;
        groupedData[key].total_area_harvested += yield.area_harvested;
      });

      // Convert to array format
      formattedYields = Object.values(groupedData).map(item => ({
        barangay: item.barangay,
        period: item.period,
        period_display: item.period_display,
        year: item.year,
        month: item.month,
        month_name: item.month_name,
        volume: item.total_volume,
        total_value: item.total_value,
        area_harvested: item.total_area_harvested,
        harvest_date: item.period_display,
        product: item.products.join(', ')
      }));
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






router.get('/farmer-yields-report', authenticate ,  async (req, res) => {
  try {
    // Extract and clean the IDs
    const farmerId = req.query.farmerId ? req.query.farmerId.split(':')[0].trim() : null;
    const barangayName = req.query.barangayName ? req.query.barangayName.trim() : null;
    const productId = req.query.productId ? req.query.productId.split(':')[0].trim() : null;
    const associationId = req.query.associationId ? req.query.associationId.split(':')[0].trim() : null;
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
          fy.area_harvested,   
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
            SUM(fy.area_harvested) as area_harvested,   
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
            SUM(fy.area_harvested) as area_harvested,  
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
        total_value: yield.Value ? parseFloat(yield.Value) : null,
        area_harvested: yield.area_harvested ? parseFloat(yield.area_harvested) : null
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








router.get('/farmers-report', authenticate , async (req, res) => {
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
          f.sex,
          f.birthday,
          f.address,
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
      'Sex': farmer.sex,
      'Birthday': farmer.birthday ? farmer.birthday.toISOString().split('T')[0] : '-',
      'Sector': farmer.sector,
      'Association': farmer.association_name || '-',
      'Farms': farmer.farms ? farmer.farms.split(', ') : [],
      'Address': farmer.address ? farmer.address : farmer.barangay,
      'Products': farmer.products ? farmer.products.split(', ') : [],

      '(Mt | Heads)': parseFloat(farmer.production_value) || 0,
      'Area': parseFloat(farmer.area) || 0,
      'Contact': farmer.contact,
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




router.get('/product-yields-report', authenticate ,  async (req, res) => {
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
        fy.area_harvested,
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
          SUM(fy.area_harvested) as area_harvested, 
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
          SUM(fy.area_harvested) as area_harvested,
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
          area_harvested: yield.area_harvested ? parseFloat(yield.area_harvested.toFixed(2)) : null,
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
          area_harvested: yield.area_harvested ? parseFloat(yield.area_harvested.toFixed(2)) : null, // Added area harvested
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
          area_harvested: yield.area_harvested ? parseFloat(yield.area_harvested.toFixed(2)) : null, // Added area harvested
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