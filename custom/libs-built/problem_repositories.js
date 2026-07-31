const crypto = require('crypto');
const TypeORM = require('typeorm');

const REPOSITORIES = {
  all: null,
  main: null,
  uoj: 'vjudge:uoj',
  hdu: 'vjudge:hdu',
  poj: 'vjudge:poj'
};

function normalizeRepository(value) {
  return Object.prototype.hasOwnProperty.call(REPOSITORIES, value) ? value : 'all';
}

function applyRepository(query, repository) {
  if (repository === 'all') {
    return;
  } else if (repository === 'main') {
    query.andWhere("(`type` IS NULL OR `type` NOT LIKE 'vjudge:%')");
  } else {
    query.andWhere('`type` = :repositoryType', { repositoryType: REPOSITORIES[repository] });
  }
}

function normalizeProgress(value, user) {
  if (!user) return 'all';
  return ['all', 'solved', 'attempted', 'unattempted'].includes(value) ? value : 'all';
}

function applyProgress(query, progress, user) {
  if (!user || progress === 'all') return;
  const alias = '`' + String(query.alias || 'problem').replace(/`/g, '') + '`';
  const submitted = `EXISTS (
    SELECT 1 FROM judge_state progress_state
    WHERE progress_state.user_id = :progressUserId
      AND progress_state.problem_id = ${alias}.id
  )`;
  const solved = `EXISTS (
    SELECT 1 FROM judge_state progress_state
    WHERE progress_state.user_id = :progressUserId
      AND progress_state.problem_id = ${alias}.id
      AND progress_state.status = 'Accepted'
      AND NOT EXISTS (
        SELECT 1 FROM judge_state_admin_action progress_action
        WHERE progress_action.judge_id = progress_state.id
      )
  )`;
  query.setParameter('progressUserId', user.id);
  if (progress === 'solved') query.andWhere(solved);
  if (progress === 'attempted') query.andWhere(`${submitted} AND NOT ${solved}`);
  if (progress === 'unattempted') query.andWhere(`NOT ${submitted}`);
}

async function applyVisibility(query, user) {
  query.andWhere(`NOT EXISTS (
    SELECT 1 FROM problem_v2_state archived_problem
    WHERE archived_problem.problem_id = \`${String(query.alias || 'problem').replace(/`/g, '')}\`.id
      AND archived_problem.lifecycle_status = 'archived'
  )`);
  const authorization = syzoj.utils.authorizationV2;
  const canReadAll = !!(user && await authorization.authorize(user, 'problem:read', null, { scope: 'global' }));
  if (user && !canReadAll) {
    const scopedProblemIds = await authorization.authorizedScopeIds(user, 'problem', 'problem:read');
    query.andWhere(new TypeORM.Brackets(qb => {
      qb.where('is_public = 1').orWhere('user_id = :viewerId', { viewerId: user.id });
      if (scopedProblemIds.length) qb.orWhere('id IN (:...scopedProblemIds)', { scopedProblemIds });
    }));
  } else if (!user) {
    query.andWhere('is_public = 1');
  }
  if (canReadAll) return;
  const alias = '`' + String(query.alias || 'problem').replace(/`/g, '') + '`';
  query.andWhere(`NOT EXISTS (
    SELECT 1 FROM contest active_contest
    WHERE active_contest.end_time > UNIX_TIMESTAMP()
      AND CONCAT('|',COALESCE(active_contest.problems,''),'|')
        LIKE CONCAT('%|',${alias}.id,'|%')
  )`);
}

function orderExpression(sort, repository) {
  if (sort === 'ac_rate') return 'ac_num / submit_num';
  if (sort === 'id' && ['uoj', 'hdu', 'poj'].includes(repository)) return 'CAST(vjudge_config AS UNSIGNED)';
  return sort;
}

async function hydrateProblems(problems, user) {
  for (const problem of problems) {
    problem.allowedEdit = !!(user && await syzoj.utils.authorizationV2.authorize(user, 'problem:edit', {
      id: problem.id,
      ownerId: problem.user_id,
      scope: `problem:${problem.id}`
    }, { scope: `problem:${problem.id}` }));
    problem.judge_state = await problem.getJudgeState(user, true);
    problem.tags = await problem.getTags();
  }
}

function validateSort(req, allowPublicizeTime) {
  const sort = req.query.sort || syzoj.config.sorting.problem.field;
  const order = req.query.order || syzoj.config.sorting.problem.order;
  const fields = ['id', 'title', 'ac_num', 'submit_num', 'ac_rate'];
  if (allowPublicizeTime) fields.push('publicize_time');
  if (!fields.includes(sort) || !['asc', 'desc'].includes(order)) {
    throw new ErrorMessage('错误的排序参数。');
  }
  return { sort: sort, order: order };
}

function applyKeyword(query, repository, keyword) {
  if (!keyword) return null;
  const displayMatch = /^([UHP])([1-9]\d*)$/i.exec(keyword);
  const prefixes = { uoj: 'U', hdu: 'H', poj: 'P' };
  const displayTypes = { U: 'vjudge:uoj', H: 'vjudge:hdu', P: 'vjudge:poj' };
  const expectedPrefix = prefixes[repository] || null;
  const numericKeyword = /^\d+$/.test(keyword);
  const numericId = numericKeyword && Number.isSafeInteger(Number(keyword)) && Number(keyword) <= 2147483647
    ? Number(keyword)
    : null;
  if (displayMatch) {
    const displayPrefix = displayMatch[1].toUpperCase();
    if (repository === 'all') {
      query.andWhere('`type` = :displayType', {
        displayType: displayTypes[displayPrefix]
      });
      query.andWhere('vjudge_config = :remoteId', { remoteId: displayMatch[2] });
    } else if (displayPrefix !== expectedPrefix) {
      query.andWhere('1 = 0');
    } else {
      query.andWhere('vjudge_config = :remoteId', { remoteId: displayMatch[2] });
    }
    return null;
  }

  query.andWhere(new TypeORM.Brackets(qb => {
    qb.where('title LIKE :title', { title: '%' + keyword + '%' });
    if ((repository === 'main' || repository === 'all') && numericId !== null) {
      qb.orWhere('id = :problemId', { problemId: numericId });
    }
    if (repository === 'all' && numericKeyword) {
      qb.orWhere("(`type` IN ('vjudge:uoj', 'vjudge:hdu', 'vjudge:poj') AND vjudge_config = :remoteId)", {
        remoteId: keyword
      });
    } else if (repository !== 'main' && numericKeyword) {
      qb.orWhere('vjudge_config = :remoteId', { remoteId: keyword });
    }
  }));
  if (!numericKeyword) return null;
  if (repository === 'all') {
    return numericId === null
      ? "CASE WHEN `type` IN ('vjudge:uoj', 'vjudge:hdu', 'vjudge:poj') AND vjudge_config = :remoteId THEN 0 ELSE 1 END"
      : "CASE WHEN `type` IN ('vjudge:uoj', 'vjudge:hdu', 'vjudge:poj') AND vjudge_config = :remoteId THEN 0 WHEN id = :problemId THEN 1 ELSE 2 END";
  }
  if (repository === 'main' && numericId !== null) return 'CASE WHEN id = :problemId THEN 0 ELSE 1 END';
  if (repository !== 'main') return 'CASE WHEN vjudge_config = :remoteId THEN 0 ELSE 1 END';
  return null;
}

async function renderProblems(req, res, query, repository, sortConfig, extra, priorityOrder) {
  const Problem = syzoj.model('problem');
  const displayNumberOrder = repository === 'all' && sortConfig.sort === 'id';
  if (priorityOrder) {
    query.orderBy(priorityOrder, 'ASC');
    if (!displayNumberOrder) {
      query.addOrderBy(orderExpression(sortConfig.sort, repository), sortConfig.order.toUpperCase());
    }
  } else {
    if (!displayNumberOrder) {
      query.orderBy(orderExpression(sortConfig.sort, repository), sortConfig.order.toUpperCase());
    }
  }
  if (displayNumberOrder) {
    const addOrder = priorityOrder ? 'addOrderBy' : 'orderBy';
    query[addOrder](
      "CASE WHEN `type` = 'vjudge:hdu' THEN 1 WHEN `type` = 'vjudge:poj' THEN 2 WHEN `type` = 'vjudge:uoj' THEN 3 ELSE 0 END",
      sortConfig.order.toUpperCase()
    );
    query.addOrderBy(
      "CASE WHEN `type` IN ('vjudge:uoj', 'vjudge:hdu', 'vjudge:poj') THEN CAST(vjudge_config AS UNSIGNED) ELSE id END",
      sortConfig.order.toUpperCase()
    );
    query.addOrderBy('id', sortConfig.order.toUpperCase());
  }
  if (sortConfig.sort !== 'id') query.addOrderBy('id', 'ASC');
  const paginate = syzoj.utils.paginate(
    await Problem.countForPagination(query),
    req.query.page,
    syzoj.config.page.problem
  );
  const problems = await Problem.queryPage(paginate, query);
  await hydrateProblems(problems, res.locals.user);
  const allProblemTags = await syzoj.model('problem_tag').find({});
  if (syzoj.utils.problemWorkflowV2) await syzoj.utils.problemWorkflowV2.ensureSchema();
  const categoryRows = await TypeORM.getConnection().query('SELECT id,category FROM problem_tag');
  const categories = new Map(categoryRows.map(row => [Number(row.id), row.category]));
  allProblemTags.forEach(tag => { tag.category = categories.get(Number(tag.id)) || null; });
  allProblemTags.sort((left, right) => {
    const colorOrder = ['pink', 'teal', '', 'olive', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'black'];
    const leftColor = colorOrder.indexOf(left.color || '');
    const rightColor = colorOrder.indexOf(right.color || '');
    if (leftColor !== rightColor) return (leftColor === -1 ? colorOrder.length : leftColor) - (rightColor === -1 ? colorOrder.length : rightColor);
    return String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN');
  });

  const authorization = syzoj.utils.authorizationV2;
  const [allowedCreateProblem, allowedManageTag, canBulkArchive] = res.locals.user ? await Promise.all([
    authorization.authorize(res.locals.user, 'problem:create', null, { scope: 'global' }),
    authorization.authorize(res.locals.user, 'problem:tag.manage', null, { scope: 'global' }),
    authorization.authorize(res.locals.user, 'problem:archive', null, { scope: 'global' })
  ]) : [false, false, false];
  let bulkDeleteCsrfToken = null;
  if (canBulkArchive) {
    if (!req.session.problemBulkDeleteCsrfToken) {
      req.session.problemBulkDeleteCsrfToken = crypto.randomBytes(32).toString('hex');
    }
    bulkDeleteCsrfToken = req.session.problemBulkDeleteCsrfToken;
  }

  res.render('problems', Object.assign({
    allowedCreateProblem,
    allowedManageTag,
    canBulkArchive,
    problems: problems,
    paginate: paginate,
    curSort: sortConfig.sort,
    curOrder: sortConfig.order === 'asc',
    repository: repository,
    progress: normalizeProgress(req.query.progress, res.locals.user),
    allProblemTags: allProblemTags,
    bulkDeleteCsrfToken: bulkDeleteCsrfToken
  }, extra || {}));
}

module.exports = function registerProblemRepositories() {
  const Problem = syzoj.model('problem');
  const ProblemTag = syzoj.model('problem_tag');

  app.get('/problems', async (req, res) => {
    try {
      const repository = normalizeRepository(req.query.repository);
      const progress = normalizeProgress(req.query.progress, res.locals.user);
      const sortConfig = validateSort(req, true);
      const query = Problem.createQueryBuilder();
      applyRepository(query, repository);
      await applyVisibility(query, res.locals.user);
      applyProgress(query, progress, res.locals.user);
      const keyword = String(req.query.keyword || '').trim();
      const priorityOrder = applyKeyword(query, repository, keyword);
      await renderProblems(req, res, query, repository, sortConfig, null, priorityOrder);
    } catch (e) {
      syzoj.log(e);
      res.render('error', { err: e });
    }
  });

  app.get('/problems/search', async (req, res) => {
    try {
      const repository = normalizeRepository(req.query.repository);
      const progress = normalizeProgress(req.query.progress, res.locals.user);
      const sortConfig = validateSort(req, false);
      const keyword = String(req.query.keyword || '').trim();
      const query = Problem.createQueryBuilder();
      applyRepository(query, repository);
      await applyVisibility(query, res.locals.user);
      applyProgress(query, progress, res.locals.user);
      const priorityOrder = applyKeyword(query, repository, keyword);
      await renderProblems(req, res, query, repository, sortConfig, null, priorityOrder);
    } catch (e) {
      syzoj.log(e);
      res.render('error', { err: e });
    }
  });

  app.get('/problems/tag/:tagIDs', async (req, res) => {
    try {
      const repository = normalizeRepository(req.query.repository);
      const progress = normalizeProgress(req.query.progress, res.locals.user);
      const sortConfig = validateSort(req, false);
      const tagIDs = Array.from(new Set(req.params.tagIDs.split(',').map(value => parseInt(value))));
      if (!tagIDs.length || tagIDs.some(tagID => !Number.isSafeInteger(tagID) || tagID <= 0)) {
        return res.redirect(syzoj.utils.makeUrl(['problems'], repository === 'all' ? {} : { repository: repository }));
      }

      const tags = [];
      for (const tagID of tagIDs) {
        const tag = await ProblemTag.findById(tagID);
        if (!tag) return res.redirect(syzoj.utils.makeUrl(['problems'], repository === 'all' ? {} : { repository: repository }));
        tags.push(tag);
      }

      const query = Problem.createQueryBuilder();
      applyRepository(query, repository);
      await applyVisibility(query, res.locals.user);
      applyProgress(query, progress, res.locals.user);
      const keyword = String(req.query.keyword || '').trim();
      const priorityOrder = applyKeyword(query, repository, keyword);
      tagIDs.forEach((tagID, index) => {
        const parameters = {};
        parameters['tagId' + index] = tagID;
        query.andWhere(
          '`id` IN (SELECT `problem_id` FROM `problem_tag_map` WHERE `tag_id` = :tagId' + index + ')',
          parameters
        );
      });
      await renderProblems(req, res, query, repository, sortConfig, { tags: tags }, priorityOrder);
    } catch (e) {
      syzoj.log(e);
      res.render('error', { err: e });
    }
  });
};

module.exports.normalizeRepository = normalizeRepository;
