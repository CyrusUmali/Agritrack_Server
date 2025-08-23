// yieldsRoutes.js
const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/firebase-auth-middleware');
const admin = require('firebase-admin');
const pool = require('../connect');

 
 
 

router.get('/sectors/stats', async (req, res) => {
  try {
    // Query to get all sectors with their statistics
    const [sectors] = await pool.query(`
      SELECT 
        s.sector_id,
        s.sector_name,
        COALESCE(SUM(f.area), 0) AS total_land_area,
        COUNT(DISTINCT f.farmer_id) AS total_farmers,
        COALESCE(SUM(fy.volume), 0) AS total_yield_volume,
        COALESCE(SUM(fy.Value), 0) AS total_yield_value
      FROM sectors s
      LEFT JOIN farm_products p ON s.sector_id = p.sector_id
      LEFT JOIN farms f ON JSON_CONTAINS(f.products, CONCAT('"', p.id, '"'), '$')
      LEFT JOIN farmer_yield fy ON fy.product_id = p.id AND fy.farm_id = f.farm_id
      GROUP BY s.sector_id, s.sector_name
      ORDER BY s.sector_name
    `);

    // Additional query to get yield trends by month for each sector
    const [yieldTrends] = await pool.query(`
      SELECT 
        s.sector_id,
        DATE_FORMAT(fy.harvest_date, '%Y-%m') AS month,
        SUM(fy.volume) AS monthly_volume,
        SUM(fy.Value) AS monthly_value
      FROM sectors s
      JOIN farm_products p ON s.sector_id = p.sector_id
      JOIN farmer_yield fy ON fy.product_id = p.id
      WHERE fy.harvest_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 12 MONTH)
      GROUP BY s.sector_id, DATE_FORMAT(fy.harvest_date, '%Y-%m')
      ORDER BY s.sector_id, month
    `);

    // Process the data to include yield trends with each sector
    const result = sectors.map(sector => {
      const trends = yieldTrends
        .filter(trend => trend.sector_id === sector.sector_id)
        .map(trend => ({
          month: trend.month,
          volume: parseFloat(trend.monthly_volume) || 0,
          value: parseFloat(trend.monthly_value) || 0
        }));

      return {
        sectorId: sector.sector_id,
        sectorName: sector.sector_name,
        totalLandArea: parseFloat(sector.total_land_area) || 0,
        totalFarmers: parseInt(sector.total_farmers) || 0,
        totalYieldVolume: parseFloat(sector.total_yield_volume) || 0,
        totalYieldValue: parseFloat(sector.total_yield_value) || 0,
        yieldTrends: trends
      };
    });

    res.json({
      success: true,
      sectors: result
    });
  } catch (error) {
    console.error('Failed to fetch sector statistics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch sector statistics',
      error: {
        code: 'SECTOR_STATS_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
}); 


router.get('/sectors', async (req, res) => {
  try {
    const { year } = req.query;

    // 1. Base query for sector information
    const [sectors] = await pool.query(`
      SELECT 
        s.sector_id,
        s.sector_name,
        s.description,
        s.created_at,
        s.updated_at
      FROM sectors s
      ORDER BY s.sector_name ASC
    `);

    if (!sectors.length) {
      return res.json({
        success: true,
        sectors: [],
        totals: {
          totalLandArea: 0,
          totalAreaHarvested: 0,
          totalFarmers: 0,
          totalFarms: 0,
          totalYields: 0,
          totalYieldVolume: 0,
          totalYieldValue: 0,
          totalMetricTons: 0
        }
      });
    }

    // 2. Farm stats (includes land area from farms)
    const [farmStats] = await pool.query(`
      SELECT 
        s.sector_id,
        COUNT(DISTINCT f.farmer_id) AS farmer_count,
        COUNT(DISTINCT f.farm_id) AS farm_count,
        SUM(f.area) AS total_area
      FROM sectors s
      LEFT JOIN farms f ON s.sector_id = f.sector_id
      GROUP BY s.sector_id
    `);

    // 3. Yield stats query (now includes area_harvested and metric tons)
    let yieldStatsQuery = `
      SELECT 
        fp.sector_id,
        COUNT(DISTINCT fy.id) AS yield_count,
        SUM(fy.volume) AS total_volume,
        SUM(fy.Value) AS total_value,
        SUM(fy.area_harvested) AS total_area_harvested,
        SUM(fy.volume) / 1000 AS total_metric_tons  -- Convert kg to metric tons (1000kg = 1 metric ton)
      FROM farmer_yield fy
      JOIN farm_products fp ON fy.product_id = fp.id
      JOIN sectors s ON fp.sector_id = s.sector_id
      WHERE fy.status = 'Accepted'
    `;

    if (year) {
      yieldStatsQuery += ` AND YEAR(fy.harvest_date) = ?`;
    }

    yieldStatsQuery += ` GROUP BY fp.sector_id`;

    const [yieldStats] = year
      ? await pool.query(yieldStatsQuery, [year])
      : await pool.query(yieldStatsQuery);

    // 4. Totals query (added total_area_harvested and total_metric_tons)
    let totalsQuery = `
      SELECT 
        COUNT(DISTINCT f.farmer_id) AS total_farmers,
        COUNT(DISTINCT f.farm_id) AS total_farms,
        SUM(f.area) AS total_land_area,
        SUM(fy.area_harvested) AS total_area_harvested,
        COUNT(DISTINCT fy.id) AS total_yields,
        SUM(fy.volume) AS total_yield_volume,
        SUM(fy.Value) AS total_yield_value,
        SUM(fy.volume) / 1000 AS total_metric_tons
      FROM farms f
      LEFT JOIN farmer_yield fy 
        ON f.farm_id = fy.farm_id 
        AND fy.status = 'Accepted'
    `;

    if (year) {
      totalsQuery += ` WHERE YEAR(fy.harvest_date) = ?`;
    }

    const [totals] = year
      ? await pool.query(totalsQuery, [year])
      : await pool.query(totalsQuery);

    // 5. Combine sector info with stats (added totalAreaHarvested and metricTons)
    const processedSectors = sectors.map(sector => {
      const farmStat = farmStats.find(stat => stat.sector_id === sector.sector_id) || {};
      const yieldStat = yieldStats.find(stat => stat.sector_id === sector.sector_id) || {};

      return {
        id: sector.sector_id,
        name: sector.sector_name,
        description: sector.description,
        createdAt: sector.created_at,
        updatedAt: sector.updated_at,
        stats: {  
          totalLandArea: farmStat.total_area ? parseFloat(farmStat.total_area) : 0,
          totalAreaHarvested: yieldStat.total_area_harvested ? parseFloat(yieldStat.total_area_harvested.toFixed(2)) : 0,
          totalFarmers: farmStat.farmer_count ? parseInt(farmStat.farmer_count) : 0,
          totalFarms: farmStat.farm_count ? parseInt(farmStat.farm_count) : 0,
          totalYields: yieldStat.yield_count ? parseInt(yieldStat.yield_count) : 0,
          totalYieldVolume: yieldStat.total_volume ? parseFloat(yieldStat.total_volume) : 0,
          totalYieldValue: yieldStat.total_value ? parseFloat(yieldStat.total_value) : 0,
          metricTons: yieldStat.total_metric_tons ? parseFloat(yieldStat.total_metric_tons) : 0
        }
      };
    });

    // 6. Prepare totals data (added totalAreaHarvested and totalMetricTons)
    const processedTotals = {
      totalLandArea: totals[0].total_land_area ? parseFloat(totals[0].total_land_area) : 0,
      totalAreaHarvested: totals[0].total_area_harvested ? parseFloat(totals[0].total_area_harvested) : 0,
      totalFarmers: totals[0].total_farmers ? parseInt(totals[0].total_farmers) : 0,
      totalFarms: totals[0].total_farms ? parseInt(totals[0].total_farms) : 0,
      totalYields: totals[0].total_yields ? parseInt(totals[0].total_yields) : 0,
      totalYieldVolume: totals[0].total_yield_volume ? parseFloat(totals[0].total_yield_volume) : 0,
      totalYieldValue: totals[0].total_yield_value ? parseFloat(totals[0].total_yield_value) : 0,
      totalMetricTons: totals[0].total_metric_tons ? parseFloat(totals[0].total_metric_tons) : 0
    };

    // 7. Response
    res.json({
      success: true,
      sectors: processedSectors,
      totals: processedTotals,
      ...(year && { yearFilter: year })
    });

  } catch (error) {
    console.error('Failed to fetch sector data:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch sector data',
      error: {
        code: 'SECTOR_FETCH_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});




router.get('/sectors/:sectorId', async (req, res) => {
  try {
    const { sectorId } = req.params;
    const { year } = req.query;

    // Validate sectorId
    if (!sectorId || isNaN(sectorId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid sector ID provided'
      });
    }

    // Base sector information
    const [sectorInfo] = await pool.query(`
      SELECT 
        sector_id,
        sector_name,
        description,
        mission,
        imgUrl,
        created_at,
        updated_at
      FROM sectors
      WHERE sector_id = ?
    `, [sectorId]);

    if (!sectorInfo.length) {
      return res.status(404).json({
        success: false,
        message: 'Sector not found'
      });
    }

    // Current year stats - Added status='Accepted' condition
    const [currentStats] = await pool.query(`
      SELECT 
        COUNT(DISTINCT f.farmer_id) as total_farmers,
        COUNT(DISTINCT f.farm_id) as total_farms,
        SUM(f.area) as total_land_area,
        AVG(f.area) as avg_farm_size,
        COUNT(DISTINCT fy.id) as total_yields,
        SUM(fy.volume) as total_yield_volume,
        SUM(fy.Value) as total_yield_value
      FROM farms f
      LEFT JOIN farmer_yield fy ON f.farm_id = fy.farm_id AND fy.status = 'Accepted'
      WHERE f.sector_id = ?
      ${year ? 'AND YEAR(fy.harvest_date) = ?' : ''}
    `, year ? [sectorId, year] : [sectorId]);

    // Previous year stats for growth calculation - Added status='Accepted' condition
    let growthMetrics = {};
    if (year) {
      const prevYear = parseInt(year) - 1;
      const [prevYearStats] = await pool.query(`
        SELECT 
          SUM(fy.volume) as total_yield_volume,
          SUM(fy.Value) as total_yield_value
        FROM farms f
        JOIN farmer_yield fy ON f.farm_id = fy.farm_id AND fy.status = 'Accepted'
        WHERE f.sector_id = ? AND YEAR(fy.harvest_date) = ?
      `, [sectorId, prevYear]);

      if (prevYearStats.length && prevYearStats[0].total_yield_volume) {
        const currentVol = currentStats[0].total_yield_volume || 0;
        const prevVol = prevYearStats[0].total_yield_volume;
        const currentVal = currentStats[0].total_yield_value || 0;
        const prevVal = prevYearStats[0].total_yield_value;

        growthMetrics = {
          yieldVolumeGrowth: prevVol ? ((currentVol - prevVol) / prevVol * 100) : 0,
          yieldValueGrowth: prevVal ? ((currentVal - prevVal) / prevVal * 100) : 0
        };
      }
    }

    // Annual yield data for the last 5 years - Added status='Accepted' condition
    const [annualYield] = await pool.query(`
      SELECT 
        YEAR(fy.harvest_date) as year,
        SUM(fy.volume) as total_volume,
        SUM(fy.Value) as total_value
      FROM farms f
      JOIN farmer_yield fy ON f.farm_id = fy.farm_id AND fy.status = 'Accepted'
      WHERE f.sector_id = ?
      GROUP BY YEAR(fy.harvest_date)
      ORDER BY year DESC
      LIMIT 5
    `, [sectorId]);

    // Prepare response
    const response = {
      success: true,
      sector: {
        id: sectorInfo[0].sector_id,
        name: sectorInfo[0].sector_name,
        description: sectorInfo[0].description,
        mission: sectorInfo[0].mission,
        imgUrl: sectorInfo[0].imgUrl,
        createdAt: sectorInfo[0].created_at,
        updatedAt: sectorInfo[0].updated_at,
        stats: {
          totalFarms: currentStats[0].total_farms ? parseInt(currentStats[0].total_farms) : 0,
          totalFarmers: currentStats[0].total_farmers ? parseInt(currentStats[0].total_farmers) : 0,
          totalLandArea: currentStats[0].total_land_area ? parseFloat(currentStats[0].total_land_area) : 0,
          avgFarmSize: currentStats[0].avg_farm_size ? parseFloat(currentStats[0].avg_farm_size) : 0,
          totalYields: currentStats[0].total_yields ? parseInt(currentStats[0].total_yields) : 0,
          totalYieldVolume: currentStats[0].total_yield_volume ? parseFloat(currentStats[0].total_yield_volume) : 0,
          totalYieldValue: currentStats[0].total_yield_value ? parseFloat(currentStats[0].total_yield_value) : 0,
          ...growthMetrics
        },
        annualYield: annualYield.map(y => ({
          year: y.year,
          totalVolume: parseFloat(y.total_volume),
          totalValue: parseFloat(y.total_value)
        }))
      },
      ...(year && { yearFilter: year })
    };

    res.json(response);

  } catch (error) {
    console.error(`Failed to fetch sector details for ID ${req.params.sectorId}:`, error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch sector details',
      error: {
        code: 'SECTOR_DETAILS_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
}); 




router.get('/shi-values', async (req, res) => {
  try {
    const { year, farmerId } = req.query;

    // Helper function to add filters to queries
    const buildQuery = (baseQuery, dateField, filters = {}) => {
      let query = baseQuery;
      const params = [];
      const conditions = [];

      if (year) {
        conditions.push(`YEAR(${dateField}) = ?`);
        params.push(year);
      }

      if (farmerId) {
        conditions.push(`farmer_id = ?`);
        params.push(farmerId);
      }

      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(' AND ')}`;
      }

      return { query, params };
    };

    if (farmerId) {
      // Farmer-specific data
      const { query: landQuery, params: landParams } = buildQuery(
        `SELECT 
          SUM(area) as totalLandArea, 
          COUNT(farm_id) as numberOfFarms 
         FROM farms`,
        'created_at',
        { farmerId }
      );

      const { query: productQuery, params: productParams } = buildQuery(
        `SELECT 
          COUNT(DISTINCT product_id) as productVariety 
         FROM farmer_yield`,
        'harvest_date',
        { farmerId }
      );

      const { query: yieldQuery, params: yieldParams } = buildQuery(
        `SELECT 
          SUM(volume) as totalYield, 
          SUM(value) as totalValue 
         FROM farmer_yield`,
        'harvest_date',
        { farmerId }
      );

      const [landStats] = await pool.query(landQuery, landParams);
      const [productStats] = await pool.query(productQuery, productParams);
      const [yieldStats] = await pool.query(yieldQuery, yieldParams);

      res.json({
        success: true,
        data: {
          totalLandArea: landStats[0].totalLandArea ? parseFloat(landStats[0].totalLandArea) : 0,
          numberOfFarms: landStats[0].numberOfFarms || 0,
          productVariety: productStats[0].productVariety || 0,
          totalYield: yieldStats[0].totalYield ? parseFloat(yieldStats[0].totalYield) : 0,
          totalValue: yieldStats[0].totalValue ? parseFloat(yieldStats[0].totalValue) : 0,
          year: year || 'all-time',
          scope: 'farmer'
        }
      });

    } else {
      // System-wide data (admin view)
      const { query: landQuery, params: landParams } = buildQuery(
        `SELECT 
          SUM(area) as totalLandArea, 
          COUNT(farm_id) as numberOfFarms 
         FROM farms`,
        'created_at'
      );

      const { query: productQuery, params: productParams } = buildQuery(
        `SELECT 
          COUNT(DISTINCT product_id) as productVariety 
         FROM farmer_yield`,
        'harvest_date'
      );

      const { query: yieldQuery, params: yieldParams } = buildQuery(
        `SELECT 
          SUM(volume) as totalYield, 
          SUM(value) as totalValue 
         FROM farmer_yield`,
        'harvest_date'
      );

      const { query: activeQuery, params: activeParams } = buildQuery(
        `SELECT COUNT(DISTINCT farmer_id) as activeFarmers 
         FROM farmer_yield`,
        'harvest_date'
      );

      let inactiveQuery = `
        SELECT COUNT(DISTINCT f.id) as inactiveFarmers 
        FROM farmers f
        LEFT JOIN farmer_yield fy ON f.id = fy.farmer_id 
      `;

      let inactiveParams = [];
      if (year) {
        inactiveQuery += ` WHERE f.id NOT IN (
          SELECT DISTINCT farmer_id 
          FROM farmer_yield 
          WHERE YEAR(harvest_date) = ?
        )`;
        inactiveParams.push(year);
      } else {
        inactiveQuery += ` WHERE fy.farmer_id IS NULL`;
      }

      const [landStats] = await pool.query(landQuery, landParams);
      const [productStats] = await pool.query(productQuery, productParams);
      const [yieldStats] = await pool.query(yieldQuery, yieldParams);
      const [activeFarmers] = await pool.query(activeQuery, activeParams);
      const [inactiveStats] = await pool.query(inactiveQuery, inactiveParams);

      res.json({
        success: true,
        data: {
          totalLandArea: landStats[0].totalLandArea ? parseFloat(landStats[0].totalLandArea) : 0,
          numberOfFarms: landStats[0].numberOfFarms || 0,
          productVariety: productStats[0].productVariety || 0,
          totalYield: yieldStats[0].totalYield ? parseFloat(yieldStats[0].totalYield) : 0,
          totalValue: yieldStats[0].totalValue ? parseFloat(yieldStats[0].totalValue) : 0,
          activeFarmers: activeFarmers[0].activeFarmers || 0,
          inactiveFarmers: inactiveStats[0].inactiveFarmers || 0,
          year: year || 'all-time',
          scope: 'system'
        }
      });
    }

  } catch (error) {
    console.error('Failed to fetch SHI values:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch SHI values',
      error: error.message
    });
  }
});







router.get('/sector-yield-trends', async (req, res) => {
  try {
    // First get all sectors
    const [sectors] = await pool.query(`
      SELECT sector_id, sector_name FROM sectors
      ORDER BY sector_name ASC
    `);

    if (!sectors.length) {
      return res.json({
        success: true,
        sectorData: {}
      });
    }

    // Get yield data by year for each sector (main sector aggregates)
    const [yieldData] = await pool.query(`
      SELECT 
        p.sector_id,
        s.sector_name,
        YEAR(fy.harvest_date) as year,
        SUM(fy.volume) as total_volume
      FROM farmer_yield fy
      JOIN farm_products p ON fy.product_id = p.id
      JOIN sectors s ON p.sector_id = s.sector_id
      WHERE fy.harvest_date IS NOT NULL
      GROUP BY p.sector_id, s.sector_name, YEAR(fy.harvest_date)
      ORDER BY s.sector_name, YEAR(fy.harvest_date)
    `);

    // Get all products with their sector information
    const [products] = await pool.query(`
      SELECT 
        p.id as product_id,
        p.name as product_name,
        p.sector_id,
        s.sector_name
      FROM farm_products p
      JOIN sectors s ON p.sector_id = s.sector_id
      ORDER BY s.sector_name, p.name
    `);

    // Get yield data by product (subsectors)
    const [productYieldData] = await pool.query(`
      SELECT 
        p.id as product_id,
        p.name as product_name,
        p.sector_id,
        s.sector_name,
        YEAR(fy.harvest_date) as year,
        SUM(fy.volume) as total_volume
      FROM farmer_yield fy
      JOIN farm_products p ON fy.product_id = p.id
      JOIN sectors s ON p.sector_id = s.sector_id
      WHERE fy.harvest_date IS NOT NULL
      GROUP BY p.id, p.name, p.sector_id, s.sector_name, YEAR(fy.harvest_date)
      ORDER BY s.sector_name, p.name, YEAR(fy.harvest_date)
    `);

    // Function to generate random color in Color.fromARGB format
    const getRandomColor = () => {
      const r = Math.floor(Math.random() * 256);
      const g = Math.floor(Math.random() * 256);
      const b = Math.floor(Math.random() * 256);
      return `const Color.fromARGB(255, ${r}, ${g}, ${b})`;
    };

    // Initialize sector data structure
    const sectorData = {};
    sectors.forEach(sector => {
      sectorData[sector.sector_name] = {
        sectorData: []  // Wrap the array in a sectorData property
      };
    });

    // First process main sector aggregates
    yieldData.forEach(yieldItem => {
      const sectorName = yieldItem.sector_name;

      // Check if sector aggregate already exists
      let sectorAggregate = sectorData[sectorName].sectorData.find(s => s.name === sectorName);

      if (!sectorAggregate) {
        sectorAggregate = {
          name: sectorName,
          color: getRandomColor(),
          data: []
        };
        // Add sector aggregate as first item in the sector's array
        sectorData[sectorName].sectorData.unshift(sectorAggregate);
      }

      sectorAggregate.data.push({
        x: yieldItem.year.toString(),
        y: parseFloat(yieldItem.total_volume) || 0
      });
    });

    // Then process individual products
    productYieldData.forEach(productYield => {
      const sectorName = productYield.sector_name;
      const productName = productYield.product_name;

      // Check if this product already exists in the sector data
      let productSeries = sectorData[sectorName].sectorData.find(s => s.name === productName);

      if (!productSeries) {
        productSeries = {
          name: productName,
          color: getRandomColor(),
          data: []
        };
        sectorData[sectorName].sectorData.push(productSeries);
      }

      productSeries.data.push({
        x: productYield.year.toString(),
        y: parseFloat(productYield.total_volume) || 0
      });
    });

    // Sort data points by year for each sector/subsector
    Object.values(sectorData).forEach(sector => {
      sector.sectorData.forEach(series => {
        series.data.sort((a, b) => a.x.localeCompare(b.x));
      });
    });

    res.json({
      success: true,
      sectorData: sectorData
    });

  } catch (error) {
    console.error('Failed to fetch sector yield trends:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch sector yield trends',
      error: {
        code: 'SECTOR_YIELD_TRENDS_FETCH_ERROR',
        details: error.message,
        sqlMessage: error.sqlMessage
      }
    });
  }
});



// Get all annotations
router.get('/annotations', authenticate, async (req, res) => {
  try {
    const [annotations] = await pool.query(`
      SELECT 
        id, 
        year, 
        value, 
        text, 
        coordinate_unit AS coordinateUnit,
        horizontal_alignment AS horizontalAlignment,
        vertical_alignment AS verticalAlignment,
        created_at AS createdAt
      FROM chart_annotations
      ORDER BY created_at DESC
    `);

    res.json({
      success: true,
      annotations
    });
  } catch (error) {
    console.error('Failed to fetch annotations:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch annotations' });
  }
});

// Create new annotation
router.post('/annotations', authenticate, async (req, res) => {
  try {
    const { 
      year, 
      value, 
      text, 
      coordinateUnit = 'point', 
      horizontalAlignment = 'near', 
      verticalAlignment = 'far' 
    } = req.body;

    if (!year || !text) {
      return res.status(400).json({ 
        success: false, 
        message: 'year and text are required' 
      });
    }

    const [result] = await pool.query(
      `INSERT INTO chart_annotations 
        (year, value, text, coordinate_unit, horizontal_alignment, vertical_alignment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [year, value || 0, text, coordinateUnit, horizontalAlignment, verticalAlignment]
    );

    const [newAnnotation] = await pool.query(
      `SELECT 
        id, 
        year, 
        value, 
        text, 
        coordinate_unit AS coordinateUnit,
        horizontal_alignment AS horizontalAlignment,
        vertical_alignment AS verticalAlignment,
        created_at AS createdAt
       FROM chart_annotations WHERE id = ?`,
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      annotation: newAnnotation[0]
    });
  } catch (error) {
    console.error('Failed to create annotation:', error);
    res.status(500).json({ success: false, message: 'Failed to create annotation' });
  }
});

// Update annotation
router.put('/annotations/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      year, 
      value, 
      text, 
      coordinateUnit, 
      horizontalAlignment, 
      verticalAlignment 
    } = req.body;

    if (!text || !year) {
      return res.status(400).json({ 
        success: false, 
        message: 'year and text are required' 
      });
    }

    await pool.query(
      `UPDATE chart_annotations 
       SET 
         year = ?, 
         value = ?, 
         text = ?,
         coordinate_unit = ?,
         horizontal_alignment = ?,
         vertical_alignment = ?
       WHERE id = ?`,
      [
        year, 
        value || 0, 
        text,
        coordinateUnit,
        horizontalAlignment,
        verticalAlignment,
        id
      ]
    );

    const [updatedAnnotation] = await pool.query(
      `SELECT 
        id, 
        year, 
        value, 
        text, 
        coordinate_unit AS coordinateUnit,
        horizontal_alignment AS horizontalAlignment,
        vertical_alignment e verticalAlignment,
        created_at AS createdAt
       FROM chart_annotations WHERE id = ?`,
      [id]
    );

    res.json({
      success: true,
      annotation: updatedAnnotation[0]
    });
  } catch (error) {
    console.error('Failed to update annotation:', error);
    res.status(500).json({ success: false, message: 'Failed to update annotation' });
  }
});

// Delete annotation (remains the same as before)
router.delete('/annotations/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query(
      `DELETE FROM chart_annotations WHERE id = ?`,
      [id]
    );

    res.status(204).end();
  } catch (error) {
    console.error('Failed to delete annotation:', error);
    res.status(500).json({ success: false, message: 'Failed to delete annotation' });
  }
});





module.exports = router;